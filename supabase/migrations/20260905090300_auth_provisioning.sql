-- =============================================================================
-- ZELLÉ Lead OS — 004: Auth linkage & tenant provisioning
-- =============================================================================
-- Supabase Auth owns the `auth.users` table: credentials, sessions, OAuth
-- identities, email confirmation. You never insert into it yourself — signUp(),
-- the magic-link flow, or admin.createUser() do. What Supabase does NOT do is
-- create your application-side profile row. That is this file's job.
--
-- The mechanism is a database trigger on auth.users. It fires inside the same
-- transaction as the signup, so either both rows exist or neither does — there
-- is no window where an authenticated session has no profile.
--
-- WHERE organization_id AND role COME FROM
-- ----------------------------------------
-- Three paths, in priority order:
--
--   1. A pending invitation matching the new user's email.
--      Only an org admin can create one (RLS, migration 003), so the org/role
--      pair on it is trustworthy. This is the normal "admin adds a teammate"
--      flow the brief asks for.
--
--   2. `organization_name` in the signup metadata → create a NEW org, and make
--      this person its admin. This is the bootstrap path; a brand-new business
--      signing up for ZELLÉ. Safe because creating a fresh empty org grants
--      access to nothing that already exists.
--
--   3. Neither → organization_id stays NULL, role defaults to 'staff'.
--      Under RLS this user can read and write precisely nothing until an admin
--      places them. Unassigned fails closed.
--
-- WHY METADATA IS NOT TRUSTED FOR org_id / role
-- ---------------------------------------------
-- auth.users.raw_user_meta_data is whatever the caller passed to signUp() from
-- the browser. It is user input. If this trigger read organization_id and role
-- straight out of it, anyone could sign up with
--     { organization_id: "<a competitor's org uuid>", role: "admin" }
-- and land inside their tenant as an administrator. Only `name` and
-- `organization_name` are taken from metadata, and neither is a privilege.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Seed a usable pipeline whenever an organization is created
-- -----------------------------------------------------------------------------
create or replace function public.seed_default_org_config()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.pipeline_stages (organization_id, name, order_index)
  values
    (new.id, 'New',        0),
    (new.id, 'Contacted',  1),
    (new.id, 'Qualified',  2),
    (new.id, 'Won',        3),
    (new.id, 'Lost',       4);

  return new;
end;
$$;

create trigger organizations_seed_defaults
  after insert on public.organizations
  for each row execute function public.seed_default_org_config();

comment on function public.seed_default_org_config() is
  'Gives every new organization a default pipeline so the board is never empty. '
  'leads.status defaults to ''New'', matching the first stage exactly.';


-- -----------------------------------------------------------------------------
-- handle_new_user() — the auth.users -> public.users bridge
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email    text;
  v_org_id   uuid;
  v_role     text := 'staff';
  v_org_name text;
  v_invite   public.invitations%rowtype;
begin
  -- auth.users.email is nullable (phone-only and some OAuth signups).
  v_email := coalesce(new.email, new.raw_user_meta_data ->> 'email');

  -- ---- Path 1: a pending invitation an admin created for this address -------
  if v_email is not null then
    select *
      into v_invite
      from public.invitations i
     where lower(i.email) = lower(v_email)
       and i.accepted_at is null
       and i.expires_at > now()
     order by i.created_at desc
     limit 1;

    if found then
      v_org_id := v_invite.organization_id;
      v_role   := v_invite.role;

      update public.invitations
         set accepted_at = now(),
             accepted_by = new.id
       where id = v_invite.id;
    end if;
  end if;

  -- ---- Path 2: bootstrap — this person is founding a new organization -------
  if v_org_id is null then
    v_org_name := nullif(trim(new.raw_user_meta_data ->> 'organization_name'), '');

    if v_org_name is not null then
      insert into public.organizations (name)
      values (v_org_name)
      returning id into v_org_id;

      v_role := 'admin';
    end if;
  end if;

  -- ---- Path 3: falls through with v_org_id = NULL, v_role = 'staff' ---------

  insert into public.users (id, organization_id, name, email, role)
  values (
    new.id,
    v_org_id,
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    v_email,
    v_role
  )
  -- Idempotent: re-running provisioning for an existing profile must not abort
  -- the signup transaction.
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Creates the public.users profile for a new auth.users row. Resolves organization_id and role '
  'from a pending admin-created invitation, else from an organization_name bootstrap, else NULL/staff. '
  'Never trusts organization_id or role from signup metadata.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- -----------------------------------------------------------------------------
-- Keep the profile's email in step with the credential's email
-- -----------------------------------------------------------------------------
-- A user changing their login email through Supabase Auth would otherwise leave
-- public.users.email stale.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.users
     set email = new.email
   where id = new.id;

  return new;
end;
$$;

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function public.handle_user_email_change();


-- -----------------------------------------------------------------------------
-- invite_user_to_org() — the admin-facing entry point
-- -----------------------------------------------------------------------------
-- Callable from the client via supabase.rpc('invite_user_to_org', {...}).
-- SECURITY INVOKER (the default): it runs as the caller, so the invitations RLS
-- policies apply normally and a non-admin's INSERT is rejected by the database.
-- The explicit checks below exist to return a readable error instead of a bare
-- RLS violation.
--
-- Sending the actual invitation email is a separate, later step — from a server
-- route using supabase.auth.admin.inviteUserByEmail(). This function only
-- records the org + role assignment that the signup trigger will consume.
-- -----------------------------------------------------------------------------
create or replace function public.invite_user_to_org(
  p_email text,
  p_role  text default 'staff'
)
returns public.invitations
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid := public.current_org_id();
  v_row    public.invitations;
begin
  if v_org_id is null then
    raise exception 'You are not assigned to an organization.' using errcode = '42501';
  end if;

  if not public.is_org_admin() then
    raise exception 'Only organization admins can invite users.' using errcode = '42501';
  end if;

  if p_role not in ('admin', 'staff') then
    raise exception 'role must be admin or staff, got %', p_role using errcode = '22023';
  end if;

  insert into public.invitations (organization_id, email, role, invited_by)
  values (v_org_id, lower(trim(p_email)), p_role, (select auth.uid()))
  on conflict (organization_id, lower(email)) where accepted_at is null
  do update set role       = excluded.role,
                invited_by = excluded.invited_by,
                expires_at = now() + interval '14 days'
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.invite_user_to_org(text, text) from public, anon;
grant  execute on function public.invite_user_to_org(text, text) to authenticated;

comment on function public.invite_user_to_org(text, text) is
  'Admin-only. Records the organization_id + role a given email will receive when they sign up.';
