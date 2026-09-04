-- =============================================================================
-- ZELLÉ Lead OS — 005: Machine API keys + atomic lead ingestion
-- =============================================================================
-- Two things live here:
--   1. public.api_keys      — server-to-server credentials, one org per key
--   2. public.ingest_lead() — the entire ingestion pipeline as ONE statement
--
-- WHY THE INGESTION LOGIC IS IN THE DATABASE AND NOT IN THE ROUTE
-- ----------------------------------------------------------------
-- The requirement is that steps 4-6 (create lead, create conversation, assign,
-- log activities) either all happen or none of them do.
--
-- That is impossible to do from the Supabase JS client. Each `.insert()` is a
-- separate HTTP request to PostgREST, and each request is its own transaction
-- that commits the moment it succeeds. Four inserts in a row means four
-- independent commits: if the third fails you are left with a lead that has no
-- conversation and no audit trail, and there is no way to undo the first two.
-- `supabase-js` has no `.transaction()` — this is a real limitation, not an
-- oversight, because HTTP requests cannot share a database session.
--
-- A single function call is a single statement, and Postgres wraps every
-- statement in an implicit transaction. If anything inside raises — a
-- constraint violation, a null where one is not allowed, a bug — the whole
-- thing rolls back as if the call never happened. That is the entire reason
-- this is 200 lines of PL/pgSQL rather than TypeScript.
--
-- The route still owns authentication (401) and payload validation (400),
-- because those must happen before any database work and need to produce clear
-- HTTP errors.
-- =============================================================================


-- pgcrypto supplies gen_random_bytes() for issue_api_key(). Present by default
-- on Supabase; declared here so this migration stands on its own.
create extension if not exists pgcrypto with schema extensions;


-- -----------------------------------------------------------------------------
-- A new activity type
-- -----------------------------------------------------------------------------
-- Migration 001 allowed five activity types, none of which mean "the AI scored
-- and summarised this lead". Rather than overload 'status_change' and bury the
-- meaning inside the content jsonb, the constraint gains a sixth value.
alter table public.activities
  drop constraint activities_type_check,
  add constraint activities_type_check check (
    type in ('status_change', 'note', 'assignment', 'call_logged',
             'follow_up_set', 'ai_qualified')
  );


-- -----------------------------------------------------------------------------
-- Find the unassigned queue quickly
-- -----------------------------------------------------------------------------
-- Migration 001 indexed assigned_to only WHERE it is NOT NULL, which is exactly
-- the wrong half for the "Unassigned" view. When no active staff exist a lead
-- is stored with assigned_to = NULL, and this partial index makes finding those
-- rows cheap so they surface as a queue instead of quietly accumulating.
create index leads_unassigned_idx
  on public.leads (organization_id, created_at desc)
  where assigned_to is null;


-- -----------------------------------------------------------------------------
-- api_keys
-- -----------------------------------------------------------------------------
-- WHY THE HASH AND NOT THE KEY
-- Storing the raw key would mean anyone who can read this table — a leaked
-- backup, a SQL injection elsewhere, a support engineer running a SELECT — can
-- immediately write leads into that organization. Storing only a hash means a
-- reader gets a value they cannot turn back into a usable credential.
--
-- WHY PLAIN SHA-256 AND NOT BCRYPT
-- User passwords are hashed with bcrypt/argon2 because passwords are low
-- entropy: people pick 'summer2024', and a fast hash lets an attacker try
-- billions of guesses. Those algorithms are deliberately slow and salted with a
-- random value.
--
-- A random salt is not usable here. The lookup is "find the org for this
-- incoming key", so the hash must be deterministic — the same key must always
-- produce the same value, or there is nothing to match against without trying
-- every row.
--
-- That is safe for this specific case because these keys are not passwords:
-- they are 32 bytes from a cryptographically secure random generator, i.e. 256
-- bits of entropy. There is no dictionary to try and no meaningful way to brute
-- force one. Slow hashing buys nothing when the input space is that large.
--
-- The security of this whole scheme rests on that generator. A key that is not
-- high-entropy random breaks the reasoning above — see src/lib/api-key.ts.
-- -----------------------------------------------------------------------------
create table public.api_keys (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null references public.organizations (id) on delete cascade,
  name             text        not null default 'Untitled key'
                               check (length(trim(name)) between 1 and 100),
  key_hash         text        not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  last_used_at     timestamptz,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz
);

create index api_keys_organization_id_idx on public.api_keys (organization_id);

-- The hot path is "hash the incoming key, find the live row". Partial index so
-- revoked keys are not scanned.
create index api_keys_active_hash_idx
  on public.api_keys (key_hash)
  where revoked_at is null;

comment on table public.api_keys is
  'Server-to-server credentials for the ingestion endpoint. One organization per key. '
  'Only the SHA-256 hash of the key is stored; the raw value is shown once at creation and never again.';
comment on column public.api_keys.key_hash is
  'Lowercase hex SHA-256 of the raw key string. Must match hashApiKey() in src/lib/api-key.ts exactly.';
comment on column public.api_keys.revoked_at is
  'Set to now() to disable a key. Revoking is preferred over deleting so the audit trail survives.';


-- -----------------------------------------------------------------------------
-- api_keys — RLS
-- -----------------------------------------------------------------------------
-- This table is written and read by the ingestion route using the service_role
-- key, which bypasses RLS entirely. The policy below exists for a future admin
-- UI: an org admin may list their own keys.
--
-- Note what is granted. Column-level GRANT is used so `key_hash` is not in the
-- set of readable columns at all — an admin can see that a key exists, when it
-- was last used, and revoke it, but cannot read the hash itself. A policy alone
-- would not do this: RLS filters rows, GRANT filters columns.
alter table public.api_keys enable row level security;

revoke all on public.api_keys from anon, authenticated;
grant select (id, organization_id, name, last_used_at, created_at, revoked_at)
  on public.api_keys to authenticated;

create policy "api_keys: admin read own org"
  on public.api_keys for select to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());


-- =============================================================================
-- ingest_lead — the whole pipeline, atomically
-- =============================================================================
-- Returns a jsonb envelope the route maps onto an HTTP status:
--   {"status":"unauthorized"}                        -> 401
--   {"status":"duplicate",  "lead_id":…}             -> 200
--   {"status":"created",    "lead_id":…, …}          -> 201
--
-- Note the first parameter: the KEY HASH, not an organization_id. The function
-- resolves the organization itself. There is deliberately no way to tell it
-- which org to write into — a caller who wanted to target another tenant would
-- have to already possess that tenant's API key, at which point they are simply
-- an authorised caller. The "organization_id is never read from the body" rule
-- is therefore enforced by the shape of this signature, not by remembering to
-- do the right thing in TypeScript.
--
-- SECURITY DEFINER: runs as the owner, so it works regardless of RLS. Execute
-- is granted to service_role only.
-- =============================================================================
create or replace function public.ingest_lead(
  p_key_hash text,
  p_payload  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_api_key_id        uuid;
  v_org_id            uuid;
  v_source_message_id text;
  v_existing_lead_id  uuid;
  v_lead_id           uuid;
  v_conversation_id   uuid;
  v_status            text;
  v_assignee          uuid;
  v_assignee_name     text;
  v_messages          jsonb;
  v_fields            jsonb;
begin
  -- ---- 1. Authenticate ------------------------------------------------------
  select ak.id, ak.organization_id
    into v_api_key_id, v_org_id
    from public.api_keys ak
   where ak.key_hash = p_key_hash
     and ak.revoked_at is null;

  if not found then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  v_source_message_id := p_payload ->> 'source_message_id';

  -- ---- 3. Idempotency -------------------------------------------------------
  -- Cheap pre-check. It does not eliminate the race between two simultaneous
  -- deliveries of the same message — the unique index does that, and the
  -- exception handler further down turns the loser into a clean 'duplicate'
  -- rather than a 500.
  select l.id into v_existing_lead_id
    from public.leads l
   where l.organization_id = v_org_id
     and l.source_message_id = v_source_message_id;

  if found then
    return jsonb_build_object(
      'status',          'duplicate',
      'lead_id',         v_existing_lead_id,
      'organization_id', v_org_id
    );
  end if;

  update public.api_keys set last_used_at = now() where id = v_api_key_id;

  -- ---- 4a. Opening status = this org's first pipeline stage ------------------
  -- Looked up, never hardcoded: an org may have renamed 'New' to 'Inbox'.
  -- The coalesce is a safety net for an org with no stages at all, which the
  -- seeding trigger should make impossible.
  select ps.name into v_status
    from public.pipeline_stages ps
   where ps.organization_id = v_org_id
   order by ps.order_index asc, ps.created_at asc
   limit 1;

  v_status := coalesce(v_status, 'New');

  -- ---- 5. Round-robin assignment --------------------------------------------
  -- Serialise assignment per organization. Without this, two webhooks arriving
  -- at the same moment both read the same "who was assigned longest ago" answer
  -- and both pick the same person, so one staff member gets two leads and
  -- another gets none. The advisory lock is held until this transaction ends
  -- and only blocks other ingests for the SAME org.
  perform pg_advisory_xact_lock(hashtextextended(v_org_id::text, 0));

  select u.id, u.name
    into v_assignee, v_assignee_name
    from public.users u
    left join lateral (
      select max(l.created_at) as last_assigned_at
        from public.leads l
       where l.assigned_to = u.id
    ) la on true
   where u.organization_id = v_org_id
     and u.is_active
     and u.role in ('admin', 'staff')
   -- NULLS FIRST puts anyone who has never been assigned at the front of the
   -- queue; after that, whoever waited longest. created_at breaks ties so the
   -- ordering is deterministic.
   order by la.last_assigned_at asc nulls first, u.created_at asc
   limit 1;

  -- ---- 4b. Create the lead --------------------------------------------------
  v_fields := coalesce(p_payload -> 'ai_qualification' -> 'fields', '{}'::jsonb);
  if jsonb_typeof(v_fields) <> 'object' then
    v_fields := '{}'::jsonb;
  end if;

  begin
    insert into public.leads (
      organization_id, assigned_to, name, phone, channel, source,
      ai_score, ai_summary, status, qualification_data, source_message_id
    )
    values (
      v_org_id,
      v_assignee,
      nullif(trim(p_payload -> 'lead' ->> 'name'), ''),
      nullif(trim(p_payload -> 'lead' ->> 'phone'), ''),
      p_payload ->> 'channel',
      p_payload ->> 'source',
      (p_payload -> 'ai_qualification' ->> 'score')::integer,
      nullif(trim(p_payload -> 'ai_qualification' ->> 'summary'), ''),
      v_status,
      v_fields,
      v_source_message_id
    )
    returning id into v_lead_id;
  exception
    when unique_violation then
      -- Another delivery of the same message won the race between our check
      -- above and this insert. Report the winner's id; do not create a second
      -- lead. Same outcome as the pre-check, just arrived at differently.
      select l.id into v_existing_lead_id
        from public.leads l
       where l.organization_id = v_org_id
         and l.source_message_id = v_source_message_id;

      return jsonb_build_object(
        'status',          'duplicate',
        'lead_id',         v_existing_lead_id,
        'organization_id', v_org_id
      );
  end;

  -- ---- 4c. Create the conversation ------------------------------------------
  v_messages := coalesce(p_payload -> 'conversation' -> 'messages', '[]'::jsonb);
  if jsonb_typeof(v_messages) <> 'array' then
    v_messages := '[]'::jsonb;
  end if;

  insert into public.conversations (organization_id, lead_id, messages)
  values (v_org_id, v_lead_id, v_messages)
  returning id into v_conversation_id;

  -- ---- 6a. Activity: the AI qualified this lead ------------------------------
  -- actor_id must be NULL for actor_type 'ai' (CHECK in migration 001).
  insert into public.activities (organization_id, lead_id, actor_type, actor_id, type, content)
  values (
    v_org_id, v_lead_id, 'ai', null, 'ai_qualified',
    jsonb_build_object(
      'score',    (p_payload -> 'ai_qualification' ->> 'score')::integer,
      'summary',  p_payload -> 'ai_qualification' ->> 'summary',
      'fields',   v_fields,
      'channel',  p_payload ->> 'channel',
      'source',   p_payload ->> 'source',
      'status',   v_status
    )
  );

  -- ---- 6b. Activity: assignment outcome --------------------------------------
  if v_assignee is not null then
    insert into public.activities (organization_id, lead_id, actor_type, actor_id, type, content)
    values (
      v_org_id, v_lead_id, 'system', null, 'assignment',
      jsonb_build_object(
        'assigned_to',      v_assignee,
        'assigned_to_name', v_assignee_name,
        'rule',             'round_robin'
      )
    );
  else
    -- The "Unassigned" case. The brief asks for this to be findable rather than
    -- silently lost, so it is recorded explicitly instead of being inferred
    -- from the absence of an assignment row. Pair this with leads_unassigned_idx.
    insert into public.activities (organization_id, lead_id, actor_type, actor_id, type, content)
    values (
      v_org_id, v_lead_id, 'system', null, 'assignment',
      jsonb_build_object(
        'assigned_to', null,
        'rule',        'round_robin',
        'result',      'unassigned',
        'reason',      'no_active_users_in_organization'
      )
    );
  end if;

  return jsonb_build_object(
    'status',          'created',
    'lead_id',         v_lead_id,
    'conversation_id', v_conversation_id,
    'organization_id', v_org_id,
    'assigned_to',     v_assignee,
    'lead_status',     v_status
  );
end;
$$;

comment on function public.ingest_lead(text, jsonb) is
  'Atomic lead ingestion for POST /api/ingest/lead. Resolves the organization from the API key '
  'hash — never from the payload. Idempotent on (organization_id, source_message_id). '
  'Returns a jsonb envelope with status unauthorized | duplicate | created.';

-- Reachable only with the service_role key. A logged-in end user has no
-- business calling this, and anonymous visitors certainly do not.
revoke execute on function public.ingest_lead(text, jsonb) from public, anon, authenticated;
grant  execute on function public.ingest_lead(text, jsonb) to service_role;


-- =============================================================================
-- Helper: issue an API key from SQL
-- =============================================================================
-- Generates a key, stores only its hash, and returns the raw value ONCE. There
-- is no way to recover it afterwards — that is the point of storing a hash.
--
-- sha256() is built into Postgres 11+, so this matches the Node implementation
-- without needing the pgcrypto extension. Both sides compute:
--     lowercase hex of SHA-256 over the UTF-8 bytes of the raw key string.
-- =============================================================================
create or replace function public.issue_api_key(
  p_organization_id uuid,
  p_name            text default 'Untitled key'
)
returns table (api_key text, key_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_raw text;
  v_id  uuid;
begin
  -- 32 bytes from pgcrypto's CSPRNG, base64 then made URL-safe and unpadded.
  v_raw := 'zlk_' || rtrim(
    translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'),
    '='
  );

  insert into public.api_keys (organization_id, name, key_hash)
  values (
    p_organization_id,
    p_name,
    encode(sha256(convert_to(v_raw, 'UTF8')), 'hex')
  )
  returning id into v_id;

  return query select v_raw, v_id;
end;
$$;

comment on function public.issue_api_key(uuid, text) is
  'Creates an API key for an organization and returns the raw value exactly once. '
  'Only the SHA-256 hash is persisted. Copy the returned key immediately — it cannot be recovered.';

revoke execute on function public.issue_api_key(uuid, text) from public, anon, authenticated;
grant  execute on function public.issue_api_key(uuid, text) to service_role;
