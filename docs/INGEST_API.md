# POST /api/ingest/lead — reference & manual test guide

The endpoint n8n calls once the AI bot has qualified a lead.

**Not yet executed.** Migration 005 has never been run and the endpoint has
never served a request. It compiles and builds cleanly (`tsc --noEmit` and
`next build` both pass), but everything below is unverified against a live
database. Work through the tests here before pointing n8n at it.

---

## Contract

`POST /api/ingest/lead`
`Authorization: Bearer <api-key>`
`Content-Type: application/json`

```json
{
  "channel": "instagram",
  "source": "manychat",
  "source_message_id": "ig_msg_9001",
  "lead": { "name": "Ananya Rao", "phone": "+91 98200 33333" },
  "ai_qualification": {
    "score": 88,
    "summary": "Wants to train 4x a week. Budget confirmed.",
    "fields": { "goal": "weight_loss", "budget_month": "6000" }
  },
  "conversation": {
    "messages": [
      { "sender": "lead", "text": "do you do 1-on-1 sessions?", "timestamp": "2026-03-08T10:02:00Z" },
      { "sender": "ai",   "text": "We do. What is your goal?",  "timestamp": "2026-03-08T10:02:14Z" }
    ]
  }
}
```

`lead.phone` is the only optional field. `conversation.messages` may be an empty
array. There is no `organization_id` field — see below.

### Responses

| Status | `error.code` / `status` | Meaning |
|---|---|---|
| 201 | `created` | Lead, conversation and activities written |
| 200 | `duplicate` | This `source_message_id` was already ingested; nothing written |
| 400 | `invalid_json` | Body is not parseable JSON |
| 400 | `invalid_payload` | Failed validation; `error.details` lists each problem |
| 401 | `missing_api_key` | No usable `Authorization: Bearer` header |
| 401 | `invalid_api_key` | Key unknown or revoked |
| 405 | `method_not_allowed` | Anything other than POST |
| 500 | `internal_error` | Unexpected. Nothing partial was written; safe to retry |

Every response includes `request_id`, also sent as `X-Request-Id` and written to
the server logs — quote it when something needs diagnosing.

Success bodies carry `duplicate: true|false`, so a workflow can branch without
inspecting the status code.

---

## Concepts

### Why `organization_id` is not in the payload

It cannot be sent, and would be ignored if it were. The route hashes the
incoming API key and passes **the hash** to `ingest_lead()`, which resolves the
organization itself. There is no parameter anywhere on that path through which a
caller could name a different tenant.

That is stronger than validating a supplied `organization_id` against the key.
Validation is a check you can forget to write; here the wrong value is simply not
representable. A workflow pointed at the wrong org writes nothing anywhere —
which is what you want when a mistake happens at 3am.

If a payload does contain `organization_id`, Zod strips it and the route logs a
warning, because a workflow sending one is misconfigured and someone should find
out.

### Hashing, and why not bcrypt

The database stores only a SHA-256 hash of each key. Anyone who reads the
`api_keys` table — a leaked backup, a support engineer, SQL injection somewhere
else — gets a value they cannot turn back into a working credential.

Passwords are normally hashed with bcrypt or argon2, which are deliberately slow
and salted with a random value per password. Neither property works here:

- **Salting** would make the hash non-deterministic. The lookup is "find the org
  for this key" with no username to narrow it down, so the same key must always
  produce the same hash or there is nothing to match.
- **Slowness** exists to make guessing expensive. Passwords need it because
  people choose `summer2024`. These keys are 32 bytes from the OS
  cryptographically secure generator — 256 bits of entropy, no dictionary to
  try, brute force not a meaningful threat.

The argument holds **only** for randomly generated keys. A hand-picked key like
`test123` would be trivially brute-forced against a plain SHA-256. That is why
the test key below is fenced off as local-only and `issue_api_key()` exists for
anything real.

### Transactions, and why the logic is in SQL

Steps 4–6 must be all-or-nothing: a lead with no conversation, or with no audit
trail, is corrupt data.

The Supabase JS client cannot express that. Each `.insert()` is a separate HTTP
request to PostgREST, and each request is its own transaction that commits on
success. Four inserts is four independent commits — if the third fails, the
first two are already permanent and there is nothing to roll back. `supabase-js`
has no `.transaction()`, and cannot: HTTP requests do not share a database
session.

A **transaction** is a group of statements Postgres treats as one indivisible
unit. Either every change lands, or none does. Postgres wraps every single
statement in one implicitly — so one call to `ingest_lead()` is one transaction.
Any error inside, from a constraint violation to a bug, discards everything the
function did.

That is the whole reason ingestion lives in PL/pgSQL rather than TypeScript.

### `service_role`, and what it costs

This route uses the service role key, which **bypasses Row Level Security
entirely**. Correct here — n8n is a machine, there is no user session, so RLS has
no organization to derive and would block everything. Authorization comes
entirely from the API key check instead.

The cost is that this code path has no safety net. On a user-facing route a
forgotten `.eq('organization_id', …)` is caught by RLS; here it would leak
across tenants. That is the second reason the multi-tenant logic sits inside
`ingest_lead()` instead of being assembled from client calls.

`src/lib/supabase/admin.ts` imports `server-only`, so the build fails if this
client is ever pulled into a Client Component.

### Round-robin under concurrency

Assignment picks the active user who was assigned longest ago, never-assigned
first. Two webhooks arriving simultaneously would both read the same answer and
both pick the same person, so `ingest_lead()` takes a
`pg_advisory_xact_lock` keyed on the organization — a lock held until the
transaction ends that only blocks other ingests for the *same* org.

---

## 1. Create a test API key

Run in the Supabase SQL editor. This uses a **known, hardcoded** key so you have
the raw value for your test requests:

```sql
-- ⚠️ LOCAL TESTING ONLY. This key is published in the repo and is not random,
-- so the entropy argument above does not protect it. Never create a key this
-- way in a project holding real data — use issue_api_key() for that.
insert into public.api_keys (organization_id, name, key_hash)
values (
  'a0000000-0000-4000-a000-000000000001',                    -- Acme Fitness Studio
  'Local curl test',
  encode(sha256(convert_to('zlk_local_test_only_00000000000000000000', 'UTF8')), 'hex')
)
on conflict (key_hash) do update set revoked_at = null       -- re-runnable
returning id, organization_id, name, key_hash;
```

Your raw key is:

```
zlk_local_test_only_00000000000000000000
```

**Why this matches the code.** Both sides compute lowercase hex SHA-256 over the
UTF-8 bytes of the raw key string — `encode(sha256(convert_to(k,'UTF8')),'hex')`
in SQL, `createHash("sha256").update(k,"utf8").digest("hex")` in
[`src/lib/api-key.ts`](../src/lib/api-key.ts). Same input, same algorithm, same
encoding. Confirm it if you like:

```sql
select encode(sha256(convert_to('zlk_local_test_only_00000000000000000000', 'UTF8')), 'hex');
```

```powershell
$k = 'zlk_local_test_only_00000000000000000000'
$sha = [System.Security.Cryptography.SHA256]::Create()
-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($k)) | ForEach-Object { $_.ToString('x2') })
```

Both must print:

```
6e1085f3842b6b16c5d228b39d0fff6016ab7583ebf54929d4787ec3b0679f6b
```

(That value was computed with the actual `hashApiKey()` implementation, so if
your SQL prints something different, the two sides have diverged and every
request will 401.)

**For a real key**, instead:

```sql
select * from issue_api_key('a0000000-0000-4000-a000-000000000001', 'n8n production');
```

That returns the raw key **once** — copy it immediately, it cannot be recovered.

---

## 2. Start the server

```powershell
cp .env.example .env.local     # then fill in the three values
npm run dev
```

`SUPABASE_SERVICE_ROLE_KEY` comes from Dashboard → Settings → API → `service_role`.
It never leaves the server.

---

## 3. PowerShell tests

Paste this setup block first. `Invoke-RestMethod` throws on any non-2xx, which
makes testing a 401 awkward, so this helper catches the error and returns the
status and parsed body either way — and works on both Windows PowerShell 5.1 and
PowerShell 7.

```powershell
$IngestUrl = 'http://localhost:3000/api/ingest/lead'
$GoodKey   = 'zlk_local_test_only_00000000000000000000'

function Invoke-Ingest {
    param([string]$Key, [string]$Body)

    $headers = @{}
    if ($Key) { $headers['Authorization'] = "Bearer $Key" }

    try {
        $r = Invoke-WebRequest -Uri $IngestUrl -Method Post -Headers $headers `
             -ContentType 'application/json' -Body $Body -UseBasicParsing
        [pscustomobject]@{ Status = [int]$r.StatusCode; Body = ($r.Content | ConvertFrom-Json) }
    }
    catch {
        $status = 0
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        $payload = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $payload = $_.ErrorDetails.Message | ConvertFrom-Json
        }
        [pscustomobject]@{ Status = $status; Body = $payload }
    }
}

$Payload = @'
{
  "channel": "instagram",
  "source": "manychat",
  "source_message_id": "ig_msg_9001",
  "lead": { "name": "Ananya Rao", "phone": "+91 98200 33333" },
  "ai_qualification": {
    "score": 88,
    "summary": "Wants to train 4x a week before summer. Budget confirmed at 6000/month.",
    "fields": { "goal": "weight_loss", "budget_month": "6000", "start_when": "this_month" }
  },
  "conversation": {
    "messages": [
      { "sender": "lead", "text": "hi, do you do 1-on-1 sessions?", "timestamp": "2026-03-08T10:02:00Z" },
      { "sender": "ai", "text": "We do! What is your main goal right now?", "timestamp": "2026-03-08T10:02:14Z" },
      { "sender": "lead", "text": "want to lose weight before summer, 4x a week", "timestamp": "2026-03-08T10:03:31Z" }
    ]
  }
}
'@
```

### (a) Valid request — expect 201

```powershell
$a = Invoke-Ingest -Key $GoodKey -Body $Payload
$a.Status          # 201
$a.Body | Format-List
```

✅ Pass:

```
status      : created
duplicate   : False
lead_id     : <a new uuid>
assigned_to : <Priya's or Sam's uuid>
lead_status : New
```

`lead_status` is `New` because that is Acme's first pipeline stage by
`order_index` — looked up, not hardcoded. Rename that stage and this changes.

`assigned_to` should be populated. If it is `null`, the org has no active users.

### (b) Same request again — expect 200, no duplicate

```powershell
$b = Invoke-Ingest -Key $GoodKey -Body $Payload
$b.Status                          # 200, NOT 201
$b.Body.duplicate                  # True
$b.Body.lead_id -eq $a.Body.lead_id # True — same lead, not a new one
```

✅ Pass: `200`, `duplicate = True`, and the same `lead_id` as (a).

Then confirm nothing was created in the database:

```sql
select count(*) from leads         where source_message_id = 'ig_msg_9001';  -- 1
select count(*) from conversations where lead_id = '<lead_id from (a)>';     -- 1
select count(*) from activities    where lead_id = '<lead_id from (a)>';     -- 2
```

Two activities, not four — the second call wrote nothing at all.

### (c) Bad and missing keys — expect 401

```powershell
# wrong key
$c1 = Invoke-Ingest -Key 'zlk_definitely_not_a_real_key' -Body $Payload
$c1.Status                # 401
$c1.Body.error.code       # invalid_api_key

# no Authorization header at all
$c2 = Invoke-Ingest -Key '' -Body $Payload
$c2.Status                # 401
$c2.Body.error.code       # missing_api_key
```

✅ Pass: both 401, with different `error.code` values so n8n can tell "the header
is missing" from "the key is wrong".

Note that (c) used a **valid** payload and still got 401 — authentication runs
before validation, so a caller with a bad key learns nothing about whether their
body would have been accepted.

### (d) Worth adding: malformed payload — expect 400

```powershell
$bad = '{"channel":"telegram","source":"manychat","lead":{},"ai_qualification":{"score":150,"fields":{}},"conversation":{"messages":[]}}'
$d = Invoke-Ingest -Key $GoodKey -Body $bad
$d.Status                 # 400
$d.Body.error.details     # one line per problem
```

✅ Pass — `details` should name each field:

```
channel: must be one of 'instagram', 'facebook', 'whatsapp'
source_message_id: Required
lead.name: Required
ai_qualification.score: must be between 0 and 100
ai_qualification.summary: Required
```

### (e) Worth adding: a revoked key stops working

```sql
update api_keys set revoked_at = now()
 where key_hash = encode(sha256(convert_to('zlk_local_test_only_00000000000000000000','UTF8')),'hex');
```

Re-run (a) → `401 invalid_api_key`. Then un-revoke:

```sql
update api_keys set revoked_at = null
 where key_hash = encode(sha256(convert_to('zlk_local_test_only_00000000000000000000','UTF8')),'hex');
```

### (f) Worth adding: cross-org isolation

Issue a key for Bright Smile Dental, send the *same* `source_message_id`:

```sql
select * from issue_api_key('b0000000-0000-4000-a000-000000000001', 'Org B test');
```

```powershell
$e = Invoke-Ingest -Key '<the key just returned>' -Body $Payload
$e.Status   # 201 — a separate lead, in Org B
```

✅ Pass: 201, not 200. Idempotency is scoped per organization, so two tenants
using the same upstream message id do not block each other. Confirm:

```sql
select organization_id, name from leads where source_message_id = 'ig_msg_9001';  -- 2 rows, different orgs
```

---

## 4. Verify what landed

```sql
select l.id, l.name, l.status, l.ai_score, l.assigned_to, u.name as assignee,
       l.qualification_data
  from leads l
  left join users u on u.id = l.assigned_to
 where l.source_message_id = 'ig_msg_9001';

select jsonb_array_length(messages) as message_count, messages
  from conversations where lead_id = '<lead_id>';   -- 3

select actor_type, type, content
  from activities where lead_id = '<lead_id>' order by created_at;
```

Expected activities:

| actor_type | type | content |
|---|---|---|
| `ai` | `ai_qualified` | score, summary, fields, channel, source, status |
| `system` | `assignment` | `assigned_to`, `assigned_to_name`, `rule: round_robin` |

### Round-robin actually rotating

```sql
select u.name, count(l.*) as leads, max(l.created_at) as last_assigned
  from users u left join leads l on l.assigned_to = u.id
 where u.organization_id = 'a0000000-0000-4000-a000-000000000001'
 group by u.name order by last_assigned nulls first;
```

Send a few requests with different `source_message_id` values and watch
assignment alternate between Priya and Sam.

### The Unassigned case

```sql
update users set is_active = false
 where organization_id = 'a0000000-0000-4000-a000-000000000001';
```

Ingest with a fresh `source_message_id` → still `201`, but `assigned_to` is
`null`. The lead is not lost:

```sql
-- the Unassigned queue, backed by leads_unassigned_idx
select id, name, created_at from leads
 where organization_id = 'a0000000-0000-4000-a000-000000000001'
   and assigned_to is null
 order by created_at desc;

-- and it is explicit in the audit trail, not merely implied
select content from activities
 where lead_id = '<lead_id>' and type = 'assignment';
-- {"rule":"round_robin","result":"unassigned","reason":"no_active_users_in_organization"}
```

Re-activate afterwards: `update users set is_active = true where organization_id = 'a0000000-…-000000000001';`

---

## 5. Clean up

```sql
delete from leads where source_message_id like 'ig_msg_9%';
delete from api_keys where name in ('Local curl test', 'Org B test', 'n8n production');
```

---

## Not built yet

- **Rate limiting.** A leaked key can be used as fast as the network allows.
  Worth adding before production — Vercel's firewall, or a counter in Postgres.
- **Key rotation UI.** `issue_api_key()` and `revoked_at` are the primitives; no
  interface exists yet.
- **The n8n shared secret.** `N8N_WEBHOOK_SECRET` is in `.env.example` but
  unused; `safeCompare()` in `src/lib/api-key.ts` is there for when you add it
  as a second factor alongside the API key.
- **Message shape inconsistency.** This endpoint stores messages as
  `{sender, text, timestamp}` per the spec, but
  `supabase/fixtures/rls_test_fixture.sql` seeded `{role, text, at}`. Two shapes
  in one column will bite whoever renders the transcript. Worth standardising on
  one before building the UI — the fixture is the easier one to change.
