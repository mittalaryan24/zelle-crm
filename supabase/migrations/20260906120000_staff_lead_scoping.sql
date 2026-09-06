-- =============================================================================
-- ZELLÉ Lead OS — 006: Staff-level lead scoping
-- =============================================================================
-- WHAT CHANGES, AND WHY
-- ---------------------
-- Migration 003 scoped leads to the organization and stopped there, with the
-- comment "Admin and staff are identical here by design. 'Only admins may
-- reassign a lead' is enforced in the application layer."
--
-- That was correct while the only client was the ingestion route, which uses
-- the service role and bypasses RLS entirely. It stops being correct the moment
-- a browser holds a user's JWT: Stage 3 puts a real staff login in front of this
-- data, and the requirement is that a staff user's query is *incapable* of
-- returning another rep's lead — not merely that the UI declines to draw it.
--
-- Those are very different guarantees. Filtering in the application layer means
-- the rows are still reachable: a staff user can read their access token out of
-- browser storage and query PostgREST directly, and org-scoped RLS will hand
-- over every lead in the organization. Only the database can close that.
--
-- THE NEW RULE
--   admin  -> every lead in their organization   (unchanged)
--   staff  -> only leads where assigned_to = them (new restriction)
--
-- Tenant isolation is untouched: `organization_id = current_org_id()` still
-- guards the outer boundary, and this narrows what a staff user sees *within*
-- their own org. Org A can no more see Org B than before.
--
-- WHAT THIS DOES NOT CHANGE
--   * service_role still bypasses all of it, so ingestion and round-robin
--     assignment are unaffected.
--   * INSERT and DELETE on leads stay org-scoped. Neither is exposed in the
--     Stage 3 UI, and narrowing them would mean a staff user could create a
--     lead they are then unable to read.
--
-- Re-runnable: every policy is dropped by name before being recreated.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- leads
-- -----------------------------------------------------------------------------
-- `assigned_to = (select auth.uid())` rather than bare auth.uid() for the same
-- reason migration 003 gives: the subquery form is hoisted into an InitPlan and
-- evaluated once per statement instead of once per row scanned.
--
-- A NULL assigned_to (the unassigned queue) matches no staff user, because
-- `NULL = <uuid>` is NULL rather than false. Unassigned leads are therefore
-- admin-visible only, which is exactly the brief: the Unassigned filter is an
-- admin affordance for spotting leads that round-robin could not place.

drop policy if exists "leads: read own org" on public.leads;

create policy "leads: read own org"
  on public.leads for select to authenticated
  using (
    organization_id = public.current_org_id()
    and (
      public.is_org_admin()
      or assigned_to = (select auth.uid())
    )
  );

-- UPDATE is narrowed to match. Without this a staff user could not *read* a
-- colleague's lead but could still write to it — status changes included —
-- which is a stranger hole than the one we just closed.
--
-- WITH CHECK deliberately omits the assigned_to test that USING applies. USING
-- decides which rows you may target; WITH CHECK decides what the row may look
-- like afterwards. Requiring `assigned_to = auth.uid()` in WITH CHECK would
-- make reassignment impossible for admins, since the post-image belongs to
-- someone else by definition. The organization test stays in both, so a lead
-- can never be updated out of its tenant.

drop policy if exists "leads: update own org" on public.leads;

create policy "leads: update own org"
  on public.leads for update to authenticated
  using (
    organization_id = public.current_org_id()
    and (
      public.is_org_admin()
      or assigned_to = (select auth.uid())
    )
  )
  with check (organization_id = public.current_org_id());


-- -----------------------------------------------------------------------------
-- conversations and activities — inherit the rule rather than restate it
-- -----------------------------------------------------------------------------
-- A transcript and a note history are as sensitive as the lead they hang off.
-- Leaving these org-scoped would let a staff user read the full conversation of
-- a lead they cannot open, just by querying with its lead_id.
--
-- The condition is written as "…and you can see the parent lead" rather than by
-- copying the admin-or-assignee test. Policy expressions are evaluated as the
-- calling user, so the subquery against public.leads is itself filtered by the
-- leads policy above. That means this rule cannot drift out of sync with the
-- leads rule — it *is* the leads rule, by reference.
--
-- No recursion risk: the leads policy does not read conversations or activities.
-- The lookup is by primary key, and conversations/activities are already indexed
-- on lead_id, so the added cost is an index probe per row.

drop policy if exists "conversations: read own org" on public.conversations;

create policy "conversations: read own org"
  on public.conversations for select to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (
      select 1 from public.leads l where l.id = conversations.lead_id
    )
  );

drop policy if exists "activities: read own org" on public.activities;

create policy "activities: read own org"
  on public.activities for select to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (
      select 1 from public.leads l where l.id = activities.lead_id
    )
  );

-- Appending an activity gets the same treatment. The existing policy already
-- forced actor_type='user' and actor_id=auth.uid() — you may only log actions
-- as yourself — but said nothing about *which lead* you may log them against.
-- A staff user could therefore write notes onto a colleague's lead.

drop policy if exists "activities: insert into own org as self" on public.activities;

create policy "activities: insert into own org as self"
  on public.activities for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and actor_type = 'user'
    and actor_id = (select auth.uid())
    and exists (
      select 1 from public.leads l where l.id = activities.lead_id
    )
  );


-- -----------------------------------------------------------------------------
-- Verify
-- -----------------------------------------------------------------------------
-- Expected after running this file, using the Stage 1 fixture:
--
--   as Sam   (staff, Org A) -> 1 lead   (Alpha; Gamma is unassigned)
--   as Priya (admin, Org A) -> 2 leads  (Alpha + Gamma)
--   as Nadia (staff, Org B) -> 1 lead   (Beta)
--
-- Impersonate with the snippet from TEST_PLAN §2 to confirm.
--
-- This last statement changes nothing. It lists the policies now in force on the
-- three tables above so you can see, on screen, that the file did what it says.
--
-- Reading it: pg_policy is the catalog Postgres keeps of every RLS policy.
-- polname is the policy's name, polrelid the table it guards, and polcmd a
-- single character for the command it covers, which the CASE expands into a
-- readable word.
--
-- The column is named on_table rather than "table". TABLE is a reserved word, so
-- it would need quoting everywhere it appears — and a quoted alias in ORDER BY
-- is exactly what broke the first version of this file. Postgres allows an
-- output alias in ORDER BY only when it stands alone: `order by on_table` is
-- fine, `order by on_table::text` is not, because the cast makes it an
-- expression, and expressions are resolved against the *input* columns of
-- pg_policy, which has no such column. Hence "column does not exist" — it was
-- never a wrong catalog column name, just an alias used one step beyond where
-- the syntax permits. Ordering below is by bare aliases only.
select
  polrelid::regclass::text                  as on_table,
  case polcmd when 'r' then 'SELECT'
              when 'a' then 'INSERT'
              when 'w' then 'UPDATE'
              when 'd' then 'DELETE'
              when '*' then 'ALL'
              else polcmd::text end         as command,
  polname                                   as policy
from pg_policy
where polrelid in ('public.leads'::regclass,
                   'public.conversations'::regclass,
                   'public.activities'::regclass)
order by on_table, command, policy;
