-- =============================================================================
-- ZELLÉ Lead OS — RLS test fixture (TEST_PLAN.md §1)
-- =============================================================================
-- Two organizations, an admin + a staff user in each, and enough leads,
-- conversations and activities for the isolation tests to have real data on
-- both sides of the tenant boundary.
--
-- HOW TO RUN
--   Paste the whole file into the Supabase dashboard SQL editor and run it.
--   It runs as `postgres`, which is correct for setup: creating fixtures is not
--   the thing being tested, and RLS is deliberately bypassed here.
--
--   Safe to re-run — it deletes its own fixtures first, by fixed id, so a failed
--   run leaves nothing behind to clean up by hand.
--
--   NOT named seed.sql on purpose: `supabase db reset` auto-runs supabase/seed.sql,
--   and this file creates login-capable users. Keep it opt-in.
--
-- IDS ARE FIXED AND MNEMONIC
--   Everything starting a0000000-… belongs to Org A.
--   Everything starting b0000000-… belongs to Org B.
--   So you can paste the snippets in TEST_PLAN §2/§3 verbatim, with no uuid
--   hunting, and spot a cross-org leak in a result set at a glance.
--
--   Org A .............. a0000000-0000-4000-a000-000000000001  Acme Fitness Studio
--   Org B .............. b0000000-0000-4000-a000-000000000001  Bright Smile Dental
--
--   Priya  (Org A, admin) a0000000-0000-4000-a000-000000000011  admin-a@example.com
--   Sam    (Org A, staff) a0000000-0000-4000-a000-000000000012  staff-a@example.com
--   Diego  (Org B, admin) b0000000-0000-4000-a000-000000000011  admin-b@example.com
--   Nadia  (Org B, staff) b0000000-0000-4000-a000-000000000012  staff-b@example.com
--
--   Leads  Org A ....... …0101 Lead Alpha   (assigned to Sam)
--                        …0102 Lead Gamma   (unassigned)
--          Org B ....... …0101 Lead Beta    (assigned to Nadia)
--                        …0102 Lead Delta   (unassigned)
--
--   Password for all four users: ZelleTest123!
--
-- ⚠️  TEST DATA ONLY. Four accounts with a known password. Never run against a
--     database that holds real customer data.
-- =============================================================================

-- pgcrypto provides crypt()/gen_salt() for the password hashes. Present by
-- default on Supabase in the `extensions` schema; this makes the file portable.
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;


-- -----------------------------------------------------------------------------
-- 0. Clean up any previous run
-- -----------------------------------------------------------------------------
-- Order matters. Deleting auth.users cascades to public.users, which nulls
-- leads.assigned_to; deleting organizations then cascades leads, conversations,
-- activities, pipeline_stages and qualification_field_defs.
delete from auth.users
 where id in (
   'a0000000-0000-4000-a000-000000000011',
   'a0000000-0000-4000-a000-000000000012',
   'b0000000-0000-4000-a000-000000000011',
   'b0000000-0000-4000-a000-000000000012'
 );

delete from public.organizations
 where id in (
   'a0000000-0000-4000-a000-000000000001',
   'b0000000-0000-4000-a000-000000000001'
 );


-- -----------------------------------------------------------------------------
-- 1. Organizations
-- -----------------------------------------------------------------------------
-- The organizations_seed_defaults trigger fires on each insert and creates the
-- 5 default pipeline stages, so none are inserted by hand below.
insert into public.organizations (id, name) values
  ('a0000000-0000-4000-a000-000000000001', 'Acme Fitness Studio'),
  ('b0000000-0000-4000-a000-000000000001', 'Bright Smile Dental');


-- -----------------------------------------------------------------------------
-- 2. Auth users
-- -----------------------------------------------------------------------------
-- Written straight into auth.users so the whole fixture is one paste. Normally
-- signUp() or auth.admin.createUser() does this; here we need fixed uuids.
--
-- email_confirmed_at is set so the accounts can log in immediately without a
-- confirmation email — needed for the §3 curl tests.
--
-- The on_auth_user_created trigger fires for each row and creates the matching
-- public.users profile with organization_id NULL and role 'staff'. Step 3
-- assigns the real org and role. (That the profiles appear at all is itself the
-- first check in TEST_PLAN §1.)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
select
  '00000000-0000-0000-0000-000000000000',
  u.id, 'authenticated', 'authenticated', u.email,
  crypt('ZelleTest123!', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('name', u.display_name),
  '', '', '', ''
from (values
  ('a0000000-0000-4000-a000-000000000011'::uuid, 'admin-a@example.com', 'Priya Sharma'),
  ('a0000000-0000-4000-a000-000000000012'::uuid, 'staff-a@example.com', 'Sam Okafor'),
  ('b0000000-0000-4000-a000-000000000011'::uuid, 'admin-b@example.com', 'Diego Ramos'),
  ('b0000000-0000-4000-a000-000000000012'::uuid, 'staff-b@example.com', 'Nadia Haddad')
) as u(id, email, display_name);

-- GoTrue requires a matching auth.identities row for password sign-in.
-- The column set has changed across Supabase versions (provider_id is newer),
-- so build the insert to match whatever this project actually has.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'identities'
       and column_name = 'provider_id'
  ) then
    insert into auth.identities (id, user_id, identity_data, provider, provider_id,
                                 last_sign_in_at, created_at, updated_at)
    select gen_random_uuid(), u.id,
           jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
           'email', u.id::text, now(), now(), now()
      from auth.users u
     where u.id in ('a0000000-0000-4000-a000-000000000011',
                    'a0000000-0000-4000-a000-000000000012',
                    'b0000000-0000-4000-a000-000000000011',
                    'b0000000-0000-4000-a000-000000000012');
  else
    insert into auth.identities (id, user_id, identity_data, provider,
                                 last_sign_in_at, created_at, updated_at)
    select gen_random_uuid(), u.id,
           jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
           'email', now(), now(), now()
      from auth.users u
     where u.id in ('a0000000-0000-4000-a000-000000000011',
                    'a0000000-0000-4000-a000-000000000012',
                    'b0000000-0000-4000-a000-000000000011',
                    'b0000000-0000-4000-a000-000000000012');
  end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 3. Assign each profile to its organization
-- -----------------------------------------------------------------------------
-- These columns are blocked for anon/authenticated by the
-- users_guard_tenancy_columns trigger; it passes here because the SQL editor
-- runs as `postgres`. That asymmetry is the point — §2 tests that a real client
-- session cannot do this.
update public.users
   set organization_id = 'a0000000-0000-4000-a000-000000000001', role = 'admin'
 where id = 'a0000000-0000-4000-a000-000000000011';

update public.users
   set organization_id = 'a0000000-0000-4000-a000-000000000001', role = 'staff'
 where id = 'a0000000-0000-4000-a000-000000000012';

update public.users
   set organization_id = 'b0000000-0000-4000-a000-000000000001', role = 'admin'
 where id = 'b0000000-0000-4000-a000-000000000011';

update public.users
   set organization_id = 'b0000000-0000-4000-a000-000000000001', role = 'staff'
 where id = 'b0000000-0000-4000-a000-000000000012';


-- -----------------------------------------------------------------------------
-- 4. Qualification field definitions
-- -----------------------------------------------------------------------------
-- Different shapes per org — a fitness studio and a dental practice qualify
-- leads on different things. Makes a cross-org leak obvious on sight.
insert into public.qualification_field_defs (organization_id, field_key, label, order_index) values
  ('a0000000-0000-4000-a000-000000000001', 'goal',         'Fitness goal',        0),
  ('a0000000-0000-4000-a000-000000000001', 'budget_month', 'Monthly budget',      1),
  ('a0000000-0000-4000-a000-000000000001', 'start_when',   'Ready to start',      2),
  ('b0000000-0000-4000-a000-000000000001', 'treatment',    'Treatment interest',  0),
  ('b0000000-0000-4000-a000-000000000001', 'insurance',    'Has insurance',       1),
  ('b0000000-0000-4000-a000-000000000001', 'urgency',      'Urgency',             2);


-- -----------------------------------------------------------------------------
-- 5. Leads
-- -----------------------------------------------------------------------------
-- Note both orgs use source_message_id 'ig_msg_1001'. That is deliberate: it
-- demonstrates that the idempotency key is scoped per organization, so two
-- customers' ManyChat accounts cannot collide (TEST_PLAN §5).
insert into public.leads (
  id, organization_id, assigned_to, name, phone, channel, source,
  ai_score, ai_summary, status, qualification_data, source_message_id
) values
  -- Org A
  ('a0000000-0000-4000-a000-000000000101',
   'a0000000-0000-4000-a000-000000000001',
   'a0000000-0000-4000-a000-000000000012',            -- assigned to Sam (staff, Org A)
   'Lead Alpha', '+91 98200 11111', 'instagram', 'ig_story_ad_march',
   82, 'Wants to lose 10kg before a wedding in June. Budget confirmed, ready to start this month.',
   'Qualified',
   '{"goal":"weight_loss","budget_month":"5000","start_when":"this_month"}'::jsonb,
   'ig_msg_1001'),

  ('a0000000-0000-4000-a000-000000000102',
   'a0000000-0000-4000-a000-000000000001',
   null,                                              -- unassigned
   'Lead Gamma', '+91 98200 22222', 'whatsapp', 'wa_click_to_chat',
   41, 'Price shopping across three studios. No timeline given.',
   'Contacted',
   '{"goal":"general_fitness","budget_month":"2000"}'::jsonb,
   'wa_msg_2002'),

  -- Org B
  ('b0000000-0000-4000-a000-000000000101',
   'b0000000-0000-4000-a000-000000000001',
   'b0000000-0000-4000-a000-000000000012',            -- assigned to Nadia (staff, Org B)
   'Lead Beta', '+1 415 555 0101', 'facebook', 'fb_lead_form',
   77, 'Interested in Invisalign. Has insurance, wants a consultation next week.',
   'Qualified',
   '{"treatment":"invisalign","insurance":"yes","urgency":"next_week"}'::jsonb,
   'fb_msg_3003'),

  ('b0000000-0000-4000-a000-000000000102',
   'b0000000-0000-4000-a000-000000000001',
   null,                                              -- unassigned
   'Lead Delta', '+1 415 555 0102', 'instagram', 'ig_story_ad_march',
   35, 'Asked about teeth whitening pricing, went quiet.',
   'New',
   '{"treatment":"whitening","insurance":"no"}'::jsonb,
   'ig_msg_1001');                                    -- same id as Org A's lead, different org


-- -----------------------------------------------------------------------------
-- 6. Conversations
-- -----------------------------------------------------------------------------
-- organization_id is supplied explicitly and must equal the parent lead's — the
-- composite FK conversations_lead_fkey rejects any other value.
insert into public.conversations (id, organization_id, lead_id, messages) values
  ('a0000000-0000-4000-a000-000000000201',
   'a0000000-0000-4000-a000-000000000001',
   'a0000000-0000-4000-a000-000000000101',
   '[
      {"role":"user","text":"hi, saw your reel about the 12 week program","at":"2026-03-02T09:14:00Z"},
      {"role":"assistant","text":"Hey! Happy to help. What is your main goal right now?","at":"2026-03-02T09:14:20Z"},
      {"role":"user","text":"lose about 10kg before my wedding in june","at":"2026-03-02T09:15:02Z"},
      {"role":"assistant","text":"That is very doable. What monthly budget did you have in mind?","at":"2026-03-02T09:15:20Z"},
      {"role":"user","text":"around 5000 is fine","at":"2026-03-02T09:16:11Z"}
    ]'::jsonb),

  ('a0000000-0000-4000-a000-000000000202',
   'a0000000-0000-4000-a000-000000000001',
   'a0000000-0000-4000-a000-000000000102',
   '[
      {"role":"user","text":"how much for personal training","at":"2026-03-04T17:41:00Z"},
      {"role":"assistant","text":"Packages start at 2000/month. When are you looking to begin?","at":"2026-03-04T17:41:18Z"}
    ]'::jsonb),

  ('b0000000-0000-4000-a000-000000000201',
   'b0000000-0000-4000-a000-000000000001',
   'b0000000-0000-4000-a000-000000000101',
   '[
      {"role":"user","text":"do you do invisalign?","at":"2026-03-03T11:02:00Z"},
      {"role":"assistant","text":"We do. Are you covered by dental insurance?","at":"2026-03-03T11:02:14Z"},
      {"role":"user","text":"yes through my employer. can i come in next week?","at":"2026-03-03T11:03:40Z"}
    ]'::jsonb),

  ('b0000000-0000-4000-a000-000000000202',
   'b0000000-0000-4000-a000-000000000001',
   'b0000000-0000-4000-a000-000000000102',
   '[
      {"role":"user","text":"whitening price?","at":"2026-03-05T20:10:00Z"},
      {"role":"assistant","text":"In-chair whitening is $450. Would you like to book a slot?","at":"2026-03-05T20:10:22Z"}
    ]'::jsonb);


-- -----------------------------------------------------------------------------
-- 7. Activities
-- -----------------------------------------------------------------------------
-- Covers all three actor_types. 'ai' and 'system' rows must have actor_id NULL
-- (CHECK activities_actor_id_matches_type); 'user' rows must reference someone
-- in the same org (composite FK activities_actor_fkey).
insert into public.activities (organization_id, lead_id, actor_type, actor_id, type, content) values
  -- Org A / Lead Alpha
  ('a0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000101',
   'ai', null, 'status_change', '{"from":"New","to":"Qualified","reason":"budget and timeline confirmed"}'::jsonb),
  ('a0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000101',
   'system', null, 'assignment', '{"to":"a0000000-0000-4000-a000-000000000012","rule":"round_robin"}'::jsonb),
  ('a0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000101',
   'user', 'a0000000-0000-4000-a000-000000000012', 'call_logged',
   '{"outcome":"connected","duration_seconds":420,"notes":"Booked a trial session for Saturday."}'::jsonb),
  ('a0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000101',
   'user', 'a0000000-0000-4000-a000-000000000011', 'note',
   '{"text":"High intent. Priority follow-up if she does not show Saturday."}'::jsonb),

  -- Org A / Lead Gamma
  ('a0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000102',
   'ai', null, 'status_change', '{"from":"New","to":"Contacted"}'::jsonb),
  ('a0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000102',
   'user', 'a0000000-0000-4000-a000-000000000012', 'follow_up_set',
   '{"due_at":"2026-03-11T10:00:00Z","channel":"whatsapp"}'::jsonb),

  -- Org B / Lead Beta
  ('b0000000-0000-4000-a000-000000000001', 'b0000000-0000-4000-a000-000000000101',
   'ai', null, 'status_change', '{"from":"New","to":"Qualified","reason":"insurance confirmed"}'::jsonb),
  ('b0000000-0000-4000-a000-000000000001', 'b0000000-0000-4000-a000-000000000101',
   'user', 'b0000000-0000-4000-a000-000000000012', 'call_logged',
   '{"outcome":"voicemail","duration_seconds":0,"notes":"Left message about Tuesday consult."}'::jsonb),
  ('b0000000-0000-4000-a000-000000000001', 'b0000000-0000-4000-a000-000000000101',
   'user', 'b0000000-0000-4000-a000-000000000011', 'note',
   '{"text":"Confirm Invisalign coverage percentage before the consult."}'::jsonb),

  -- Org B / Lead Delta
  ('b0000000-0000-4000-a000-000000000001', 'b0000000-0000-4000-a000-000000000102',
   'system', null, 'follow_up_set', '{"due_at":"2026-03-12T18:00:00Z","rule":"no_reply_48h"}'::jsonb);


-- -----------------------------------------------------------------------------
-- 8. Verify the fixture landed
-- -----------------------------------------------------------------------------
-- Expected: 2 orgs, each with 2 users, 2 leads, 2 conversations, 5 stages,
-- 3 field defs; Org A 6 activities, Org B 4.
select
  o.name                                                       as organization,
  (select count(*) from public.users u  where u.organization_id  = o.id) as users,
  (select count(*) from public.leads l  where l.organization_id  = o.id) as leads,
  (select count(*) from public.conversations c where c.organization_id = o.id) as conversations,
  (select count(*) from public.activities a where a.organization_id = o.id) as activities,
  (select count(*) from public.pipeline_stages p where p.organization_id = o.id) as stages,
  (select count(*) from public.qualification_field_defs q where q.organization_id = o.id) as field_defs
from public.organizations o
where o.id in ('a0000000-0000-4000-a000-000000000001',
               'b0000000-0000-4000-a000-000000000001')
order by o.name;


-- =============================================================================
-- TEARDOWN — run these two statements when you are finished testing
-- =============================================================================
-- delete from auth.users where id in (
--   'a0000000-0000-4000-a000-000000000011', 'a0000000-0000-4000-a000-000000000012',
--   'b0000000-0000-4000-a000-000000000011', 'b0000000-0000-4000-a000-000000000012');
-- delete from public.organizations where id in (
--   'a0000000-0000-4000-a000-000000000001', 'b0000000-0000-4000-a000-000000000001');
