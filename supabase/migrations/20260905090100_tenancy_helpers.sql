-- =============================================================================
-- ZELLÉ Lead OS — 002: Tenancy helper functions
-- =============================================================================
-- These exist to solve one specific problem, and it is the single most common
-- way multi-tenant RLS on Supabase goes wrong.
--
-- THE INFINITE RECURSION TRAP
-- ---------------------------
-- The obvious policy on public.users is:
--
--     using (organization_id = (select organization_id
--                                 from public.users
--                                where id = auth.uid()))
--
-- To decide whether you may read a row of `users`, Postgres runs that subquery.
-- The subquery reads `users`. Reading `users` triggers the policy. The policy
-- runs the subquery again. Postgres detects the loop and aborts every query
-- against the table with:
--
--     42P17: infinite recursion detected in policy for relation "users"
--
-- The fix is to look the org up inside a SECURITY DEFINER function. Such a
-- function executes with the privileges of the user who *created* it (the
-- migration runs as `postgres`, the table owner) rather than the user who
-- *called* it. Table owners are exempt from RLS, so the lookup inside the
-- function reads `users` directly without re-entering the policy. Loop broken.
--
-- SECURITY DEFINER IS A LOADED GUN — the two safety rules
-- -------------------------------------------------------
--  1. `set search_path = ''` and schema-qualify every name. Without this, a
--     caller who can create objects could define their own `users` table in a
--     schema that appears earlier on the search path and the elevated function
--     would happily read theirs instead. Pinning search_path removes the
--     ambiguity. (Supabase's database linter flags this as
--     `function_search_path_mutable`.)
--  2. Keep the body minimal and return the least data possible. These return a
--     single uuid / boolean — never a row set the caller shouldn't see.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- current_org_id() — the tenant key for the calling user
-- -----------------------------------------------------------------------------
-- Returns NULL when there is no authenticated user, or when the user exists but
-- has not been assigned to an organization yet. NULL is the safe answer: every
-- policy compares `organization_id = public.current_org_id()`, and in SQL
-- `<anything> = NULL` evaluates to NULL, which is not true, so no row matches.
--
-- STABLE (not VOLATILE) tells the planner the result cannot change within a
-- single statement, so it is evaluated once instead of once per row.
-- -----------------------------------------------------------------------------
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.organization_id
    from public.users u
   where u.id = (select auth.uid())
     and u.is_active
$$;

comment on function public.current_org_id() is
  'The calling user''s organization_id, or NULL if unauthenticated / unassigned / deactivated. '
  'SECURITY DEFINER to avoid infinite recursion in the users RLS policy.';


-- -----------------------------------------------------------------------------
-- is_org_admin() — used only by the invitations policies
-- -----------------------------------------------------------------------------
-- Per the brief, RLS on the business tables (leads, activities, ...) treats
-- admin and staff identically; role-based rules live in the application layer.
--
-- invitations is the deliberate exception. An invitation row IS the thing that
-- grants org membership and role at signup, so letting any staff member insert
-- one would be straightforward privilege escalation — a security boundary, not
-- a business rule. That is RLS's job.
-- -----------------------------------------------------------------------------
create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.users u
     where u.id = (select auth.uid())
       and u.is_active
       and u.role = 'admin'
  )
$$;

comment on function public.is_org_admin() is
  'True when the calling user is an active admin. Used only by invitations RLS.';


-- Callable by logged-in users; explicitly not by anonymous visitors.
revoke execute on function public.current_org_id() from public, anon;
revoke execute on function public.is_org_admin()  from public, anon;
grant  execute on function public.current_org_id() to authenticated, service_role;
grant  execute on function public.is_org_admin()  to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- Guard: organization_id, role and id are not client-writable
-- -----------------------------------------------------------------------------
-- RLS decides WHICH ROWS you may touch. It does not, on its own, stop you from
-- editing a column of a row you already own. Without this guard a staff user
-- could run:
--
--     update users set role = 'admin' where id = auth.uid();          -- escalate
--     update users set organization_id = '<other org>' where id = ... ; -- hop tenants
--
-- The second one defeats org isolation outright, so blocking it is squarely
-- RLS's remit even under the "org isolation only" rule.
--
-- Changes still flow through the service role — a server-side route where you
-- check "is the caller an admin of this org?" first. That keeps the role rules
-- in the application layer, as specified, while making the client incapable of
-- writing these columns at all.
-- -----------------------------------------------------------------------------
create or replace function public.guard_users_tenancy_columns()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- PostgREST does `SET LOCAL ROLE service_role` when the service key is used,
  -- so current_user identifies the trusted server-side path.
  if current_user in ('service_role', 'supabase_admin', 'postgres') then
    return new;
  end if;

  if new.id is distinct from old.id then
    raise exception 'users.id is immutable'
      using errcode = '42501';
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'users.organization_id cannot be changed from a client session'
      using errcode = '42501',
            hint = 'Move a user between organizations from a server-side route using the service role key.';
  end if;

  if new.role is distinct from old.role then
    raise exception 'users.role cannot be changed from a client session'
      using errcode = '42501',
            hint = 'Change roles from a server-side route that has verified the caller is an org admin.';
  end if;

  return new;
end;
$$;

create trigger users_guard_tenancy_columns
  before update on public.users
  for each row execute function public.guard_users_tenancy_columns();

comment on function public.guard_users_tenancy_columns() is
  'Makes id / organization_id / role immutable over the anon+authenticated API. '
  'service_role bypasses, so admin tooling still works server-side.';
