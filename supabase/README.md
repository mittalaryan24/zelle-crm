# ZELLÉ Lead OS — Database Layer

Schema and security only. No UI, no API routes, no Next.js code yet.

```
supabase/
├── migrations/
│   ├── 20260905090000_initial_schema.sql      tables, constraints, indexes
│   ├── 20260905090100_tenancy_helpers.sql     org lookup + column guards
│   ├── 20260905090200_rls_policies.sql        Row Level Security
│   └── 20260905090300_auth_provisioning.sql   auth.users → public.users
├── TEST_PLAN.md                               run this before building on top
└── README.md                                  you are here
```

**These have not been executed.** No Postgres was available locally, so they are
unrun. Apply them and work through `TEST_PLAN.md` before trusting anything here.

Apply with `supabase db push`, or paste each file into the dashboard SQL editor
in filename order.

---

## Concepts you should understand before relying on this

### Row Level Security (RLS)

Postgres can attach a rule to a table that gets folded into the `WHERE` clause of
every query against it, automatically. With RLS on `leads`, `select * from leads`
does not mean "all leads" — it means "all leads **that this policy allows me to
see**". The rewriting happens inside the database, underneath the API, so no
client-side trick reaches around it.

This is what makes multi-tenancy safe. The alternative — remembering to add
`.eq('organization_id', myOrg)` to every query in the app — fails the first time
someone forgets, and that failure is a cross-tenant data leak.

Two clauses:

| Clause | Question it answers | Applies to |
|---|---|---|
| `USING` | Which existing rows may I see or target? | SELECT, UPDATE, DELETE |
| `WITH CHECK` | Is the row allowed to look like this afterwards? | INSERT, UPDATE |

**UPDATE needs both.** With only `USING`, you could take a lead you own and
rewrite its `organization_id` to a competitor's — handing them the row. Only
`WITH CHECK` prevents that. The test plan checks it explicitly.

Policies are **permissive**: several policies on the same command combine with
`OR`, and each can only widen access. So a table with RLS enabled and no
policies is completely closed. Every policy in migration 003 is a deliberate,
narrow opening in an otherwise sealed table.

### RLS vs GRANT — two independent gates

They are often confused. `GRANT` decides whether a role may touch the table at
all; RLS decides which rows. A query must pass **both**. `activities` is granted
only `SELECT, INSERT` to `authenticated`, so a `DELETE` fails with *permission
denied* before RLS is even consulted — that is how the audit trail is made
append-only.

### `service_role` bypasses everything

Supabase gives you three keys:

| Key | Role | RLS |
|---|---|---|
| `anon` | `anon` | enforced (and this schema grants `anon` nothing) |
| user's access token | `authenticated` | enforced |
| `service_role` | `service_role` | **bypassed completely** |

`service_role` has the `BYPASSRLS` attribute. Every policy in this schema is
skipped for it. That is intentional — the n8n webhook needs to write leads into
whichever org the message belongs to, and it has no user session.

It is a master key to the entire database, across all tenants.

- ✅ Vercel server-side env vars, n8n credentials
- ❌ Never in `NEXT_PUBLIC_*`, never in a Client Component, never in the browser

The `postgres` role you use in the dashboard SQL editor bypasses RLS too. That
is why the test plan makes you impersonate a real user instead of testing as
yourself — the most common way people misjudge whether their RLS works.

### `SECURITY DEFINER` functions, and the recursion they solve

A normal function runs with the caller's privileges. A `SECURITY DEFINER` one
runs with the **creator's** — here `postgres`, which owns the tables and is
therefore exempt from RLS.

We need that because of a specific trap. The natural policy on `users` is
"you can see rows where `organization_id` matches yours" — but finding *yours*
means reading `users`, which triggers the policy, which reads `users` again.
Postgres detects the loop and kills every query against the table:

```
42P17: infinite recursion detected in policy for relation "users"
```

`public.current_org_id()` breaks the cycle by doing the lookup with elevated
privileges, so it reads the table directly instead of re-entering the policy.

`SECURITY DEFINER` is privilege elevation, so both functions:

1. Set `search_path = ''` and schema-qualify every name. Otherwise someone able
   to create objects could shadow `users` with their own table earlier on the
   search path, and the elevated function would read theirs. Supabase's linter
   flags the omission as `function_search_path_mutable`.
2. Return one uuid or one boolean — never a row set the caller shouldn't see.

### `(select auth.uid())`, not `auth.uid()`

`auth.uid()` reads the user id out of the request's JWT. Wrapping the call in a
subquery lets the planner evaluate it **once per statement** (an InitPlan)
instead of once per row scanned. On a table with 100k leads that is the
difference between a fast query and a slow one. Same reasoning behind marking
the helper functions `STABLE`.

### `NULL` is not equal to anything, including `NULL`

`users.organization_id` is nullable — a user who signs up without an invitation
has no org yet. Every policy compares `organization_id = current_org_id()`, and
in SQL `anything = NULL` evaluates to `NULL`, which is not `true`. So an
unassigned user matches no row anywhere and sees nothing.

This is deliberate: **unassigned fails closed.** A schema where a missing org
means "see everything" is the same bug that leaks tenants.

### Composite foreign keys as a tenancy guarantee

`conversations` and `activities` carry an `organization_id` that duplicates
their parent lead's. Denormalized data usually drifts — so it is not the app's
job to keep it right:

```sql
foreign key (lead_id, organization_id) references leads (id, organization_id)
```

Pointing the FK at *both* columns makes "this row's org equals its lead's org" a
constraint the database enforces. It cannot drift, even through a bug, a
migration, or a `service_role` script. The same pattern on `leads.assigned_to`
means a lead can never be assigned to a user from another organization — try it
in the test plan and Postgres refuses, even as superuser.

This needs `unique (id, organization_id)` on the parent tables, which is what
those otherwise-odd-looking constraints in migration 001 are for.

`ON DELETE SET NULL (assigned_to)` names the single column to null out; without
the column list Postgres would try to null `organization_id` too and hit its
`NOT NULL`. That column-list syntax requires **Postgres 15+**.

### Foreign keys are not indexed automatically

Postgres indexes primary keys and unique constraints, but **not** foreign key
columns. Missing indexes there mean slow joins and, worse, cascade deletes that
sequentially scan while holding locks. Every FK column in migration 001 gets an
index; §4 of the test plan has a query that finds any you add later and forget.

### `text` + `CHECK` instead of `ENUM`

`role`, `channel`, `actor_type` and `type` are `text` with a `CHECK` constraint
rather than Postgres `ENUM` types. Adding a value to an enum is awkward to do
safely in a migration and cannot be removed; changing a `CHECK` is one
`ALTER TABLE`. When you add a fourth channel, the second approach is trivial.

### `timestamptz`, never `timestamp`

`timestamptz` stores an absolute moment and converts on the way in and out.
`timestamp` stores a wall-clock reading with no timezone — so a lead created at
9am in Mumbai and one at 9am in London look identical and sort wrong. Your users
are on Instagram and WhatsApp across timezones; always `timestamptz`.

### `jsonb`, not `json`

`jsonb` is parsed and stored in a binary form: it can be indexed (there is a GIN
index on `leads.qualification_data`), deduplicates keys, and queries fast. `json`
keeps the raw text and re-parses on every read. Use `jsonb`.

`CHECK (jsonb_typeof(...) = 'object')` stops an array or a bare string being
written where the app expects an object — cheap insurance against the ManyChat
payload shape changing under you.

---

## Deliberate deviations from the brief

Four places where I did not build exactly what was specified. Each is a
correctness or security issue rather than a preference; revert any you disagree
with.

**1. `conversations` gained an `organization_id`.**
The spec gave it only `lead_id`, and requirement 2 said to enable RLS on tables
that have `organization_id` — which would have left conversations with no
isolation at all. They hold the actual chat transcripts, so that is the most
sensitive table in the schema. The composite FK makes the added column provably
equal to the parent lead's, and RLS filters on it directly instead of joining.

**2. `source_message_id` is unique per organization, not globally.**
The spec said unique. Globally unique means one tenant's ManyChat message id can
silently block another tenant's ingestion — a cross-tenant failure. Scoped to
the org, idempotency still works exactly as intended within each tenant.
Implemented as a partial unique index so leads created by hand, with no
`source_message_id`, are unaffected.

**3. An `invitations` table was added.**
Requirement 3 asked for `organization_id` and `role` to be "assignable by an
admin during signup". Reading them from signup metadata would let anyone sign up
as `{ organization_id: <your customer's org>, role: 'admin' }` — the metadata is
just whatever the browser posted. An admin-created invitation row is the
mechanism that makes that assignment trustworthy, so it is what requirement 3
needs rather than scope creep. It is also the only place `role` appears in RLS,
because forging an invite is privilege escalation, not a business rule.

**4. `organization_id` and `role` are not client-writable.**
The brief says role differences belong in the application layer, and they do —
"only admins can reassign leads" is not in RLS. But without a guard, any staff
user could run `update users set role = 'admin' where id = auth.uid()`, or move
themselves into another org, which defeats isolation outright. A trigger blocks
both over the `anon`/`authenticated` API; `service_role` still passes, so a
server-side route that has verified the caller is an admin can make these
changes. The role *rules* stay in the app layer; the client just can't write the
columns directly.

Also added, smaller: `updated_at` columns with a trigger, default pipeline stages
seeded per new org, and `CHECK` constraints on `ai_score` (0–100), `channel`, and
`field_key` format.

---

## What is deliberately *not* here

- Lead ↔ pipeline stage is a soft link. `leads.status` is text expected to match
  a `pipeline_stages.name`, not a foreign key, so renaming or deleting a stage
  cannot orphan leads. Reconcile in the app layer.
- No storage buckets, realtime publications, or edge functions.
- Sending invitation emails — `invite_user_to_org()` only records the
  org + role assignment. The email goes out from a server route via
  `supabase.auth.admin.inviteUserByEmail()` when you build that.

## Next

1. Apply the migrations.
2. Work through `TEST_PLAN.md` end to end, especially §3 and §6.
3. Only then generate types (`supabase gen types typescript`) and start on the
   app layer.
