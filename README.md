# ZELLÉ Lead OS

Multi-tenant lead management for businesses running AI chatbots on Instagram,
Facebook and WhatsApp. Leads are qualified by a ManyChat + n8n flow and land
here for a human team to work.

**Stack:** Next.js (App Router) · TypeScript · Tailwind · Supabase (Postgres +
Auth) · Vercel

---

## Status

🚧 **Database layer only.** No UI, no API routes, no Next.js app yet.

The migrations in [`supabase/migrations/`](supabase/migrations/) have been
written but **never executed** — they were authored without a local Postgres
available. Apply them and work through the test plan before building anything
on top.

---

## Layout

```
supabase/
├── migrations/
│   ├── …_initial_schema.sql       8 tables, constraints, indexes
│   ├── …_tenancy_helpers.sql      org lookup + column guards
│   ├── …_rls_policies.sql         Row Level Security
│   └── …_auth_provisioning.sql    auth.users → public.users
├── fixtures/
│   └── rls_test_fixture.sql       two orgs of realistic test data
├── TEST_PLAN.md                   manual verification checklist
└── README.md                      schema design + concepts explained
```

## Getting started

1. Apply the four migrations in filename order — `supabase db push`, or paste
   each into the Supabase SQL editor.
2. Load [`supabase/fixtures/rls_test_fixture.sql`](supabase/fixtures/rls_test_fixture.sql).
3. Work through [`supabase/TEST_PLAN.md`](supabase/TEST_PLAN.md) end to end.
4. `cp .env.example .env.local` and fill it in.

[`supabase/README.md`](supabase/README.md) explains every Postgres and Supabase
concept the schema relies on — RLS, `SECURITY DEFINER`, composite foreign keys
as a tenancy guarantee, and why `jsonb`/`timestamptz`/`text`+`CHECK`.

## Tenant isolation

Every tenant-owned row carries an `organization_id`, and Row Level Security
filters every query on it inside the database — not in application code. A
missing `.eq('organization_id', …)` in a query cannot leak another customer's
data, because the filter is applied below the API.

> ⚠️ **The `service_role` key bypasses RLS entirely.** It reads and writes every
> organization's data with no policy checks. Server-side only — Vercel env vars
> and n8n credentials. Never `NEXT_PUBLIC_*`, never a Client Component, never
> the browser.

## Test accounts

`supabase/fixtures/rls_test_fixture.sql` creates four accounts with a known,
published password. They exist so the isolation tests have both sides of a
tenant boundary to check against. **Delete them before this project holds real
data** — the teardown is at the bottom of that file.
