# ZELLÉ Lead OS — Schema & Isolation Test Plan

Run this yourself before anything gets built on top of the schema. Nothing below
requires writing test code — it is a checklist of things to do in the Supabase
dashboard, plus the exact snippets to paste when a step needs one.

**Status of the migrations:** written but **not executed**. There was no local
Postgres, Docker, or Supabase CLI available in this project, so they have not
been run even once. Section 0 is therefore a real step, not a formality.

---

## ⚠️ Read this first — the trap that invalidates the whole test

**The Supabase dashboard SQL editor connects as the `postgres` role, which
bypasses Row Level Security entirely.**

If you open the SQL editor and run `select * from leads;` you will see every
lead from every organization. That is expected and proves nothing. People
conclude their RLS is broken (or, worse, run a permissive query, see rows, and
conclude it is working) on the strength of that one query every day.

To test RLS you must either:

- **(A)** impersonate a specific user inside a transaction, or
- **(B)** go through the real API with a real user's access token — the higher
  fidelity option, and the one that literally answers "can they do this via the
  Supabase client".

Both are spelled out below. Section 2 uses (A) for speed; **Section 3 uses (B)
and is the one that actually counts.**

---

## 0. Apply the migrations

- [ ] Apply all four files, in filename order:
      `20260905090000_initial_schema.sql`,
      `20260905090100_tenancy_helpers.sql`,
      `20260905090200_rls_policies.sql`,
      `20260905090300_auth_provisioning.sql`
      — via `supabase db push`, or by pasting each into the SQL editor in order.
- [ ] Each one completes with no error. If one fails, stop; later files depend on it.
- [ ] Confirm your Postgres is **15 or newer** — the `ON DELETE SET NULL (column)`
      syntax on the composite foreign keys needs it:
      ```sql
      select version();
      ```
- [ ] Dashboard → **Advisors → Security**: no `rls_disabled_in_public` and no
      `function_search_path_mutable` warnings on our tables/functions.

---

## 1. Build the fixtures

- [ ] Paste **[`fixtures/rls_test_fixture.sql`](fixtures/rls_test_fixture.sql)**
      into the SQL editor and run it. That is the whole step — two orgs, four
      users, four leads, four conversations, ten activities.

      Running as `postgres` is correct here: creating fixtures is setup, not the
      thing under test. Re-running is safe; it deletes its own data first.

- [ ] The final `select` in that file prints a summary. Confirm it reads:

      | organization | users | leads | conversations | activities | stages | field_defs |
      |---|---|---|---|---|---|---|
      | Acme Fitness Studio | 2 | 2 | 2 | 6 | 5 | 3 |
      | Bright Smile Dental | 2 | 2 | 2 | 4 | 5 | 3 |

- [ ] **`stages` = 5 for both** — neither org ever inserted a pipeline stage.
      They came from the `organizations_seed_defaults` trigger.

- [ ] **`users` = 2 for both** — the fixture never inserted into `public.users`
      either, only into `auth.users`. The profiles were created by the
      `on_auth_user_created` trigger. **If these are 0, requirement 3 is broken —
      stop here and investigate before going further.**

### Fixture reference

Ids are fixed and mnemonic: `a0000000-…` is Org A, `b0000000-…` is Org B. Every
snippet below uses them literally, so there is nothing to fill in.

| | uuid | |
|---|---|---|
| **Org A** | `a0000000-0000-4000-a000-000000000001` | Acme Fitness Studio |
| **Org B** | `b0000000-0000-4000-a000-000000000001` | Bright Smile Dental |
| Priya — Org A **admin** | `a0000000-0000-4000-a000-000000000011` | admin-a@example.com |
| Sam — Org A **staff** | `a0000000-0000-4000-a000-000000000012` | staff-a@example.com |
| Diego — Org B **admin** | `b0000000-0000-4000-a000-000000000011` | admin-b@example.com |
| Nadia — Org B **staff** | `b0000000-0000-4000-a000-000000000012` | staff-b@example.com |
| Lead Alpha (Org A, → Sam) | `a0000000-0000-4000-a000-000000000101` | |
| Lead Gamma (Org A, unassigned) | `a0000000-0000-4000-a000-000000000102` | |
| Lead Beta (Org B, → Nadia) | `b0000000-0000-4000-a000-000000000101` | |
| Lead Delta (Org B, unassigned) | `b0000000-0000-4000-a000-000000000102` | |

Password for all four accounts: `ZelleTest123!`

Where a step says "as Priya" it means the Org A admin; "as Diego", the Org B
admin. Those two are the default actors unless a step names someone else.

---

## 2. (a) Org isolation — fast check by impersonation

`set local role authenticated` drops your superuser powers for the rest of the
transaction, and `request.jwt.claims` is where `auth.uid()` reads the user id
from. Together they make Postgres behave as if that user had sent the query.

Keep everything inside `begin; … rollback;` — `set local` reverts at transaction
end, so you cannot accidentally leave your editor session downgraded.

### Reads

- [ ] **Priya sees only Org A's two leads.** Four exist in the table.
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        select id, name, organization_id from leads order by name;
      rollback;
      ```
      ✅ Pass: exactly two rows — `Lead Alpha`, `Lead Gamma`. Every
      `organization_id` starts `a0000000`.
      ❌ Fail: four rows (Beta and Delta visible) → RLS not enabled, or the
      policy is wrong. This is the leak the whole plan is looking for.
      ❌ Fail: zero rows → Priya's `organization_id` is NULL or `is_active` is
      false; re-run the fixture.

- [ ] **Asking for Org B's lead by id returns nothing** — not an error, an empty
      result. RLS filters; it does not raise.
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        select * from leads where organization_id = 'b0000000-0000-4000-a000-000000000001';  -- 0 rows
        select * from leads where name = 'Lead Beta';                                        -- 0 rows
        select * from leads where id = 'b0000000-0000-4000-a000-000000000101';               -- 0 rows
      rollback;
      ```
      ✅ Pass: all three empty. Note the third — knowing a row's exact primary
      key grants nothing.

- [ ] **The same holds for every other table.** Each should return only Org A's rows:
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        select 'organizations' t, count(*) from organizations
        union all select 'users',                    count(*) from users
        union all select 'leads',                    count(*) from leads
        union all select 'conversations',            count(*) from conversations
        union all select 'activities',               count(*) from activities
        union all select 'pipeline_stages',          count(*) from pipeline_stages
        union all select 'qualification_field_defs', count(*) from qualification_field_defs;
      rollback;
      ```
      ✅ Pass — exactly Org A's share of each table, never the full count:

      | table | Priya sees | exists in table |
      |---|---|---|
      | organizations | 1 | 2 |
      | users | 2 | 4 |
      | leads | 2 | 4 |
      | conversations | 2 | 4 |
      | activities | 6 | 10 |
      | pipeline_stages | 5 | 10 |
      | qualification_field_defs | 3 | 6 |

- [ ] **Repeat as Diego** (`b0000000-0000-4000-a000-000000000011`) and confirm
      the mirror image — `Lead Beta` and `Lead Delta`, and `activities` = 4. A
      policy that accidentally hardcodes one org passes as Priya and fails here,
      so this half is not optional.

### Writes — the half people forget to test

Reading is only one direction. Confirm A cannot *write* into B.

- [ ] **Cannot insert into another org.** Blocked by `WITH CHECK`.
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        insert into leads (organization_id, name, channel)
        values ('b0000000-0000-4000-a000-000000000001', 'Injected', 'facebook');
      rollback;
      ```
      ✅ Pass: `new row violates row-level security policy for table "leads"`.

- [ ] **Cannot update another org's row.** Blocked by `USING`.
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        update leads set name = 'Hijacked' where name = 'Lead Beta';
      rollback;
      ```
      ✅ Pass: reports `UPDATE 0`. Note this is **not an error** — the row was
      invisible, so there was nothing to update. Zero rows affected is the pass.

- [ ] **Cannot give your own row away to another org.** Blocked by `WITH CHECK`
      on UPDATE — the check people most often omit.
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        update leads set organization_id = 'b0000000-0000-4000-a000-000000000001' where name = 'Lead Alpha';
      rollback;
      ```
      ✅ Pass: `new row violates row-level security policy`.

- [ ] **Cannot delete another org's row.**
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        delete from leads where name = 'Lead Beta';
      rollback;
      ```
      ✅ Pass: `DELETE 0`.

### Privilege escalation

- [ ] **A user cannot move themselves into another org** (guard trigger):
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        update users set organization_id = 'b0000000-0000-4000-a000-000000000001' where id = 'a0000000-0000-4000-a000-000000000011';
      rollback;
      ```
      ✅ Pass: `users.organization_id cannot be changed from a client session`.

- [ ] **A staff user cannot promote themselves to admin.** Sam is already staff,
      so no setup is needed — impersonate him:
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000012","role":"authenticated"}';

        update users set role = 'admin' where id = 'a0000000-0000-4000-a000-000000000012';
      rollback;
      ```
      ✅ Pass: `users.role cannot be changed from a client session`.

- [ ] **A staff user cannot forge an invitation** — the only place role is
      checked in RLS, because an invite grants org membership:
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000012","role":"authenticated"}';

        insert into invitations (organization_id, email, role)
        values ('a0000000-0000-4000-a000-000000000001', 'attacker@example.com', 'admin');
      rollback;
      ```
      ✅ Pass: `new row violates row-level security policy for table "invitations"`.
      Re-running it as Priya (`…011`) should succeed — that is the contrast worth
      seeing.

- [ ] **Activities cannot be forged in someone else's name:**
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        insert into activities (organization_id, lead_id, actor_type, actor_id, type, content)
        select organization_id, id, 'user', 'b0000000-0000-4000-a000-000000000011', 'note', '{"text":"forged"}'
          from leads where name = 'Lead Alpha';
      rollback;
      ```
      ✅ Pass: RLS violation.

- [ ] **The audit trail is append-only** — no UPDATE/DELETE grant exists:
      ```sql
      begin;
        set local role authenticated;
        set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000011","role":"authenticated"}';

        delete from activities;
      rollback;
      ```
      ✅ Pass: `permission denied for table activities`.

- [ ] **Anonymous visitors get nothing:**
      ```sql
      begin;
        set local role anon;
        select * from leads;
      rollback;
      ```
      ✅ Pass: `permission denied for table leads`.

---

## 3. (a) Org isolation — the real check, through the Supabase client

Impersonation tests the policies. This tests the policies **plus** PostgREST,
the JWT, and the grants — the whole path a browser actually takes. Do not skip
it; this is the one that answers the question you asked.

Fill in two values from Dashboard → Settings → API: your **Project URL** ref and
the **anon / public** key. The fixture already set the passwords, so no dashboard
edits are needed.

- [ ] Get a genuine access token for Priya:
      ```bash
      curl -s -X POST 'https://<PROJECT_REF>.supabase.co/auth/v1/token?grant_type=password' \
        -H "apikey: <ANON_KEY>" \
        -H "Content-Type: application/json" \
        -d '{"email":"admin-a@example.com","password":"ZelleTest123!"}'
      ```
      Copy `access_token` from the response — that is `<USER_A_ACCESS_TOKEN>` below.
      ❌ If this returns `invalid_credentials`, the `auth.identities` row did not
      get created; re-run the fixture and check the `do $$` block for an error.

- [ ] **Listing leads returns only Org A's two:**
      ```bash
      curl -s 'https://<PROJECT_REF>.supabase.co/rest/v1/leads?select=id,name,organization_id' \
        -H "apikey: <ANON_KEY>" \
        -H "Authorization: Bearer <USER_A_ACCESS_TOKEN>"
      ```
      ✅ Pass: two objects, `Lead Alpha` and `Lead Gamma`, both with an
      `organization_id` starting `a0000000`. No `b0000000` anywhere in the output.

- [ ] **Explicitly filtering for Org B returns `[]`:**
      ```bash
      curl -s 'https://<PROJECT_REF>.supabase.co/rest/v1/leads?organization_id=eq.b0000000-0000-4000-a000-000000000001' \
        -H "apikey: <ANON_KEY>" \
        -H "Authorization: Bearer <USER_A_ACCESS_TOKEN>"
      ```
      ✅ Pass: `[]`. This is the attack an attacker actually runs — they control
      the filter, and the answer is still empty.

- [ ] **Fetching Org B's lead by its primary key returns `[]`:**
      ```bash
      curl -s 'https://<PROJECT_REF>.supabase.co/rest/v1/leads?id=eq.b0000000-0000-4000-a000-000000000101' \
        -H "apikey: <ANON_KEY>" \
        -H "Authorization: Bearer <USER_A_ACCESS_TOKEN>"
      ```
      ✅ Pass: `[]`. Knowing the uuid grants nothing.

- [ ] **Writing into Org B is rejected:**
      ```bash
      curl -s -X POST 'https://<PROJECT_REF>.supabase.co/rest/v1/leads' \
        -H "apikey: <ANON_KEY>" \
        -H "Authorization: Bearer <USER_A_ACCESS_TOKEN>" \
        -H "Content-Type: application/json" \
        -d '{"organization_id":"b0000000-0000-4000-a000-000000000001","name":"Injected","channel":"facebook"}'
      ```
      ✅ Pass: HTTP 403, code `42501`, "violates row-level security policy".

- [ ] **Conversations and activities leak nothing either** — these hold the
      actual message transcripts, so check them explicitly:
      ```bash
      curl -s 'https://<PROJECT_REF>.supabase.co/rest/v1/conversations?select=*' \
        -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <USER_A_ACCESS_TOKEN>"
      curl -s 'https://<PROJECT_REF>.supabase.co/rest/v1/activities?select=*' \
        -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <USER_A_ACCESS_TOKEN>"
      ```
      ✅ Pass: 2 conversations and 6 activities, all Org A. The conversation
      transcripts mention a wedding and a 12-week program; if you see anything
      about Invisalign or teeth whitening, that is Org B's data leaking.

- [ ] **An embedded join cannot be used to reach across orgs.** PostgREST
      resolves `?select=*,conversations(*)` as a join, and RLS applies to the
      joined table too:
      ```bash
      curl -s 'https://<PROJECT_REF>.supabase.co/rest/v1/leads?select=id,name,conversations(*),activities(*)' \
        -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <USER_A_ACCESS_TOKEN>"
      ```
      ✅ Pass: Org A's two leads only, each with only its own children.

- [ ] **A staff user sees exactly what the admin sees.** Get Sam's token
      (`staff-a@example.com`, same password) and re-run the leads listing.
      ✅ Pass: the same two leads. RLS is org isolation only — staff are not
      restricted to leads assigned to them. That restriction, if you want it,
      belongs in the application layer.

- [ ] **Repeat the listing as Diego** (`admin-b@example.com`).
      ✅ Pass: `Lead Beta` and `Lead Delta` only. This is the check that catches
      a policy accidentally hardcoded to one organization.

- [ ] **A token with no org sees nothing.** Sign up a third user with no
      invitation and no `organization_name`, then list leads with their token.
      ✅ Pass: `[]` — confirms unassigned users fail closed rather than open.

---

## 4. (b) Foreign key relationships

- [ ] **Every FK exists and points where you expect.** Read this table against
      the schema in your head — it is the fastest way to catch a typo'd reference:
      ```sql
      select conrelid::regclass  as child_table,
             conname             as constraint_name,
             pg_get_constraintdef(oid) as definition
        from pg_constraint
       where contype = 'f'
         and connamespace = 'public'::regnamespace
       order by child_table, conname;
      ```
      Expect, at minimum:

      | Child | References | On delete |
      |---|---|---|
      | `users.id` | `auth.users(id)` | cascade |
      | `users.organization_id` | `organizations(id)` | cascade |
      | `invitations.organization_id` | `organizations(id)` | cascade |
      | `invitations.invited_by` / `accepted_by` | `users(id)` | set null |
      | `leads.organization_id` | `organizations(id)` | cascade |
      | `leads (assigned_to, organization_id)` | `users(id, organization_id)` | set null (assigned_to) |
      | `conversations (lead_id, organization_id)` | `leads(id, organization_id)` | cascade |
      | `activities (lead_id, organization_id)` | `leads(id, organization_id)` | cascade |
      | `activities (actor_id, organization_id)` | `users(id, organization_id)` | set null (actor_id) |
      | `pipeline_stages.organization_id` | `organizations(id)` | cascade |
      | `qualification_field_defs.organization_id` | `organizations(id)` | cascade |

- [ ] **No FK column is left unindexed.** Postgres does *not* index foreign keys
      automatically; a missing index here means slow joins and table-locking
      cascade deletes.
      ```sql
      select c.conrelid::regclass as table_name, a.attname as unindexed_fk_column
        from pg_constraint c
        join lateral unnest(c.conkey) k(attnum) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.contype = 'f'
         and c.connamespace = 'public'::regnamespace
         and not exists (
           select 1 from pg_index i
            where i.indrelid = c.conrelid
              and a.attnum = i.indkey[0]
         );
      ```
      ✅ Pass: zero rows.

- [ ] **A bad reference is rejected** (random uuid, no such organization):
      ```sql
      insert into leads (organization_id, name, channel)
      values (gen_random_uuid(), 'Orphan', 'instagram');
      ```
      ✅ Pass: `violates foreign key constraint`.

- [ ] **Cross-org assignment is impossible** — this is what the composite FKs
      buy you. Assigning Org A's lead to Org B's user must fail *at the database
      level*, not just in your app code:
      ```sql
      update leads set assigned_to = 'b0000000-0000-4000-a000-000000000011' where name = 'Lead Alpha';
      ```
      ✅ Pass: `violates foreign key constraint "leads_assigned_to_fkey"`.
      (Run as `postgres` — proving even a superuser cannot create this state.)

- [ ] **A conversation cannot claim the wrong org:**
      ```sql
      insert into conversations (organization_id, lead_id, messages)
      select 'b0000000-0000-4000-a000-000000000001', id, '[]'::jsonb from leads where name = 'Lead Alpha';
      ```
      ✅ Pass: `violates foreign key constraint "conversations_lead_fkey"`.

- [ ] **Cascade deletes reach the whole subtree.** Safe to run on Org B: the
      `rollback` puts everything back, and the fixture is re-runnable anyway.
      ```sql
      begin;
        delete from organizations where id = 'b0000000-0000-4000-a000-000000000001';

        select 'leads' t,           count(*) from leads         where organization_id = 'b0000000-0000-4000-a000-000000000001'
        union all select 'conversations',  count(*) from conversations where organization_id = 'b0000000-0000-4000-a000-000000000001'
        union all select 'activities',     count(*) from activities    where organization_id = 'b0000000-0000-4000-a000-000000000001'
        union all select 'users',          count(*) from users         where organization_id = 'b0000000-0000-4000-a000-000000000001'
        union all select 'stages',         count(*) from pipeline_stages where organization_id = 'b0000000-0000-4000-a000-000000000001';
      rollback;
      ```
      ✅ Pass: every count 0 — deleting a tenant leaves no orphaned rows behind.
      ⚠️ Make sure you actually run the `rollback`. If the editor left the
      transaction open, run it on its own before continuing.

- [ ] **Deleting a user nulls the assignment instead of deleting the lead.**
      Lead Alpha is already assigned to Sam, so just delete Sam:
      ```sql
      begin;
        delete from auth.users where id = 'a0000000-0000-4000-a000-000000000012';  -- Sam
        select name, assigned_to from leads where name = 'Lead Alpha';
      rollback;
      ```
      ✅ Pass: the row survives with `assigned_to` NULL. Losing leads when an
      employee leaves would be a serious bug.

- [ ] **And their activity history survives as a tombstone.** Sam logged a call
      on Lead Alpha; that audit entry must not vanish with him:
      ```sql
      begin;
        delete from auth.users where id = 'a0000000-0000-4000-a000-000000000012';
        select actor_type, actor_id, type from activities
         where lead_id = 'a0000000-0000-4000-a000-000000000101' and type = 'call_logged';
      rollback;
      ```
      ✅ Pass: the row is still there, `actor_type` still `'user'`, `actor_id`
      now NULL — "a person did this, but the account is gone". If this deletes
      the activity instead, the audit trail is not trustworthy.

---

## 5. Constraints and idempotency

Two of these inserts are meant to *succeed*, so wrap this whole section in
`begin; … rollback;` — or just re-run the fixture afterwards — to avoid leaving
stray leads behind.

- [ ] **Webhook replay does not duplicate a lead.** `ig_msg_1001` already exists
      in Org A (Lead Alpha):
      ```sql
      insert into leads (organization_id, name, channel, source_message_id)
      values ('a0000000-0000-4000-a000-000000000001', 'Lead Alpha again', 'instagram', 'ig_msg_1001');
      ```
      ✅ Pass: `duplicate key value violates unique constraint "leads_org_source_message_id_key"`.
      In n8n, use `upsert` with `on_conflict=organization_id,source_message_id`.

- [ ] **The same upstream id in a *different* org is allowed** — ids are scoped
      per tenant, so two customers' ManyChat accounts cannot block each other.
      The fixture already relies on this; confirm both rows exist:
      ```sql
      select name, organization_id from leads where source_message_id = 'ig_msg_1001';
      ```
      ✅ Pass: two rows — `Lead Alpha` (Org A) and `Lead Delta` (Org B). If the
      fixture loaded at all, this constraint is already proven.

- [ ] **Multiple manually-created leads with no `source_message_id` are fine:**
      ```sql
      insert into leads (organization_id, name, channel) values
        ('a0000000-0000-4000-a000-000000000001', 'Manual 1', 'whatsapp'),
        ('a0000000-0000-4000-a000-000000000001', 'Manual 2', 'whatsapp');
      ```
      ✅ Pass: both insert (Postgres treats NULLs as distinct in a unique index).

- [ ] **CHECK constraints hold** — each of these must be rejected:
      ```sql
      insert into leads (organization_id, name, channel) values ('a0000000-0000-4000-a000-000000000001', 'x', 'telegram');   -- bad channel
      insert into leads (organization_id, name, channel, ai_score) values ('a0000000-0000-4000-a000-000000000001','x','whatsapp', 150);  -- score > 100
      update users set role = 'superadmin' where id = 'a0000000-0000-4000-a000-000000000011';                              -- bad role
      insert into activities (organization_id, lead_id, actor_type, actor_id, type, content)
        select organization_id, id, 'ai', 'a0000000-0000-4000-a000-000000000011', 'note', '{}' from leads limit 1;         -- ai must have NULL actor
      ```

---

## 6. Signup and provisioning

- [ ] **Invitation path.** As Priya (Org A admin), via the client:
      ```bash
      curl -s -X POST 'https://<PROJECT_REF>.supabase.co/rest/v1/rpc/invite_user_to_org' \
        -H "apikey: <ANON_KEY>" \
        -H "Authorization: Bearer <USER_A_ACCESS_TOKEN>" \
        -H "Content-Type: application/json" \
        -d '{"p_email":"newhire@example.com","p_role":"staff"}'
      ```
      Then sign `newhire@example.com` up.
      ✅ Pass: their `users` row exists with Org A's id and role `staff`, and the
      invitation shows `accepted_at` set.

- [ ] **A staff user cannot invite.** Repeat the call with Sam's token
      (`staff-a@example.com`).
      ✅ Pass: "Only organization admins can invite users."

- [ ] **Metadata cannot be used to escalate.** Sign a new user up passing
      `options.data = { organization_id: 'b0000000-0000-4000-a000-000000000001', role: 'admin' }`.
      ✅ Pass: their row has `organization_id` NULL and role `staff` — the
      metadata was ignored. **If this one fails, the tenancy model is broken;**
      it is the single most important check in this section.

- [ ] **Bootstrap path.** Sign up passing
      `options.data = { name: 'Founder', organization_name: 'Org C' }`.
      ✅ Pass: a new `organizations` row exists, the user is its `admin`, and
      Org C has its 5 default pipeline stages.

- [ ] **Changing a login email updates the profile:**
      ```sql
      select email from users where id = 'a0000000-0000-4000-a000-000000000011';
      ```
      after changing it in Authentication → Users. Should match.

---

## 7. Clean up

- [ ] Run the teardown at the bottom of
      [`fixtures/rls_test_fixture.sql`](fixtures/rls_test_fixture.sql) — the two
      commented-out statements. Everything else cascades from those.
- [ ] Remove any extra users §6 created (`newhire@…`, the escalation-attempt
      account, the Org C founder) in Authentication → Users, and delete the
      Org C organization row.
- [ ] **Delete the four fixture accounts before this project ever holds real
      data.** They have a published password.
- [ ] Confirm the `service_role` key has not been committed anywhere, and does
      not appear in any `NEXT_PUBLIC_*` variable.

---

## Sign-off

Do not start building UI or API routes until these all pass:

- [ ] §2 — impersonated user reads/writes are confined to their own org
- [ ] §3 — the same holds through the real Supabase client, including filtered
      queries, direct-by-id lookups, and embedded joins
- [ ] §4 — every FK is present, correctly directed, indexed, and cross-org
      references are impossible
- [ ] §5 — webhook replay is idempotent per org
- [ ] §6 — signup metadata cannot assign an organization or a role
