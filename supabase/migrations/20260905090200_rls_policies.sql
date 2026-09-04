-- =============================================================================
-- ZELLÉ Lead OS — 003: Row Level Security
-- =============================================================================
-- WHAT RLS ACTUALLY IS
-- --------------------
-- Normally a `select * from leads` returns every lead. With RLS enabled,
-- Postgres silently rewrites every query to append your policy as an extra
-- WHERE clause. There is no way to opt out from the client: not by crafting a
-- URL, not by a raw filter, not by a Supabase JS call. The filter is applied by
-- the database itself, below anything the app can reach.
--
-- Two clauses do the work, and both are needed:
--   USING      — which EXISTING rows you can see or target.
--                Applies to SELECT, UPDATE, DELETE.
--   WITH CHECK — what the row is allowed to look like AFTER you write it.
--                Applies to INSERT and UPDATE.
--
-- UPDATE needs both. With only USING, a user could take a lead they legitimately
-- own and rewrite its organization_id to another tenant — handing the row away.
-- WITH CHECK is what forbids the result landing outside your org.
--
-- POLICIES ARE PERMISSIVE AND OR'd
-- --------------------------------
-- Multiple policies for the same command combine with OR — each one can only
-- ever *grant* access. So the safe default is: enable RLS, write nothing, and
-- the table is fully closed. Every policy below is an explicit, narrow opening.
--
-- `to authenticated` scopes a policy to logged-in sessions. The `anon` role
-- (the key shipped to browsers before login) matches no policy anywhere in this
-- file and therefore reads nothing.
--
-- THE ONE THING RLS DOES NOT COVER — read this before trusting it
-- ---------------------------------------------------------------
-- The `service_role` key has the BYPASSRLS attribute. Every policy here is
-- skipped for it, by design, so n8n webhooks and server jobs can write across
-- orgs. That key is a master key to the entire database.
--   * It belongs in Vercel server-side env vars and n8n credentials only.
--   * Never in NEXT_PUBLIC_*, never in a Client Component, never in the browser.
--   * Anything the browser touches uses the anon key + the user's session.
-- The same applies to the `postgres` role you are using in the Supabase SQL
-- editor — which is why the test plan makes you impersonate a real user rather
-- than testing as yourself.
-- =============================================================================

alter table public.organizations            enable row level security;
alter table public.users                    enable row level security;
alter table public.invitations              enable row level security;
alter table public.leads                    enable row level security;
alter table public.conversations            enable row level security;
alter table public.activities               enable row level security;
alter table public.pipeline_stages          enable row level security;
alter table public.qualification_field_defs enable row level security;


-- -----------------------------------------------------------------------------
-- Base privileges
-- -----------------------------------------------------------------------------
-- RLS narrows what a role can reach; it does not grant access on its own. GRANT
-- and RLS are two independent gates and a query must pass both. Supabase grants
-- broadly to anon/authenticated by default, so we reset and re-grant precisely.
-- -----------------------------------------------------------------------------
revoke all on public.organizations, public.users, public.invitations, public.leads,
              public.conversations, public.activities, public.pipeline_stages,
              public.qualification_field_defs
  from anon, authenticated;

grant select, update                 on public.organizations            to authenticated;
grant select, update                 on public.users                    to authenticated;
grant select, insert, update, delete on public.invitations              to authenticated;
grant select, insert, update, delete on public.leads                    to authenticated;
grant select, insert, update, delete on public.conversations            to authenticated;
grant select, insert                 on public.activities               to authenticated;
grant select, insert, update, delete on public.pipeline_stages          to authenticated;
grant select, insert, update, delete on public.qualification_field_defs to authenticated;
-- anon gets nothing at all.


-- =============================================================================
-- organizations — you can see and rename your own org, and only your own
-- =============================================================================
-- This table has no organization_id column; its own `id` IS the tenant key.
-- Without RLS here, any logged-in user could enumerate the name of every
-- business on the platform.
--
-- No INSERT or DELETE policy exists: orgs are created by the signup trigger
-- (which runs SECURITY DEFINER and so is not subject to these policies), and
-- deleting a tenant is a support operation for the service role.

create policy "org: read own"
  on public.organizations for select to authenticated
  using (id = public.current_org_id());

create policy "org: update own"
  on public.organizations for update to authenticated
  using      (id = public.current_org_id())
  with check (id = public.current_org_id());


-- =============================================================================
-- users — see your colleagues, edit only yourself
-- =============================================================================
-- Reading the whole org roster is required for assignment dropdowns and for
-- showing "assigned to" names. Identical for admin and staff, per the brief.
--
-- `or id = (select auth.uid())` keeps a freshly signed-up user with
-- organization_id = NULL able to load their own profile row, so the app can
-- render a "waiting to be assigned to an organization" state instead of a
-- confusing empty response.
--
-- `(select auth.uid())` rather than bare `auth.uid()`: wrapping it in a
-- subquery lets the planner hoist it into an InitPlan evaluated once for the
-- statement, instead of re-running the function for every row scanned.

create policy "users: read own org"
  on public.users for select to authenticated
  using (
    organization_id = public.current_org_id()
    or id = (select auth.uid())
  );

-- Self-service profile edits only. organization_id / role / id are additionally
-- blocked at the column level by the guard trigger in migration 002, so this
-- cannot be used to change tenant or escalate to admin.
create policy "users: update self"
  on public.users for update to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));


-- =============================================================================
-- invitations — admin-only, and only for their own org
-- =============================================================================
-- The one place role is checked in RLS. See is_org_admin() in migration 002 for
-- why this is a security boundary rather than a business rule.

create policy "invitations: admin read own org"
  on public.invitations for select to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

create policy "invitations: admin create for own org"
  on public.invitations for insert to authenticated
  with check (organization_id = public.current_org_id() and public.is_org_admin());

create policy "invitations: admin update own org"
  on public.invitations for update to authenticated
  using      (organization_id = public.current_org_id() and public.is_org_admin())
  with check (organization_id = public.current_org_id() and public.is_org_admin());

create policy "invitations: admin revoke own org"
  on public.invitations for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());


-- =============================================================================
-- leads — full CRUD inside your org, nothing outside it
-- =============================================================================
-- Admin and staff are identical here by design. "Only admins may reassign a
-- lead" is enforced in the application layer, not below this line.

create policy "leads: read own org"
  on public.leads for select to authenticated
  using (organization_id = public.current_org_id());

create policy "leads: insert into own org"
  on public.leads for insert to authenticated
  with check (organization_id = public.current_org_id());

create policy "leads: update own org"
  on public.leads for update to authenticated
  using      (organization_id = public.current_org_id())
  with check (organization_id = public.current_org_id());

create policy "leads: delete own org"
  on public.leads for delete to authenticated
  using (organization_id = public.current_org_id());


-- =============================================================================
-- conversations
-- =============================================================================
-- Filtered on the row's own organization_id rather than by joining to leads:
-- cheaper, and the composite FK in migration 001 guarantees that column always
-- equals the parent lead's org, so the two are equivalent by construction.

create policy "conversations: read own org"
  on public.conversations for select to authenticated
  using (organization_id = public.current_org_id());

create policy "conversations: insert into own org"
  on public.conversations for insert to authenticated
  with check (organization_id = public.current_org_id());

create policy "conversations: update own org"
  on public.conversations for update to authenticated
  using      (organization_id = public.current_org_id())
  with check (organization_id = public.current_org_id());

create policy "conversations: delete own org"
  on public.conversations for delete to authenticated
  using (organization_id = public.current_org_id());


-- =============================================================================
-- activities — append-only
-- =============================================================================
-- No UPDATE or DELETE policy, and no UPDATE/DELETE grant. An audit trail that
-- users can rewrite is not an audit trail. Corrections are made by appending a
-- new activity.

create policy "activities: read own org"
  on public.activities for select to authenticated
  using (organization_id = public.current_org_id());

-- A user may only log activity attributed to themselves. 'ai' and 'system' rows
-- carry actor_id = NULL (enforced by a CHECK in migration 001) and are written
-- by n8n through the service role, which bypasses this policy.
create policy "activities: insert into own org as self"
  on public.activities for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and actor_type = 'user'
    and actor_id = (select auth.uid())
  );


-- =============================================================================
-- pipeline_stages
-- =============================================================================

create policy "pipeline_stages: read own org"
  on public.pipeline_stages for select to authenticated
  using (organization_id = public.current_org_id());

create policy "pipeline_stages: insert into own org"
  on public.pipeline_stages for insert to authenticated
  with check (organization_id = public.current_org_id());

create policy "pipeline_stages: update own org"
  on public.pipeline_stages for update to authenticated
  using      (organization_id = public.current_org_id())
  with check (organization_id = public.current_org_id());

create policy "pipeline_stages: delete own org"
  on public.pipeline_stages for delete to authenticated
  using (organization_id = public.current_org_id());


-- =============================================================================
-- qualification_field_defs
-- =============================================================================

create policy "qualification_field_defs: read own org"
  on public.qualification_field_defs for select to authenticated
  using (organization_id = public.current_org_id());

create policy "qualification_field_defs: insert into own org"
  on public.qualification_field_defs for insert to authenticated
  with check (organization_id = public.current_org_id());

create policy "qualification_field_defs: update own org"
  on public.qualification_field_defs for update to authenticated
  using      (organization_id = public.current_org_id())
  with check (organization_id = public.current_org_id());

create policy "qualification_field_defs: delete own org"
  on public.qualification_field_defs for delete to authenticated
  using (organization_id = public.current_org_id());
