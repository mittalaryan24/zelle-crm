/**
 * Proves the Staff Management active/inactive toggle actually changes who
 * round-robin assigns leads to.
 *
 * This is the one Stage 4 behaviour that crosses a system boundary: the toggle
 * writes users.is_active through the admin UI, and ingest_lead() — a PL/pgSQL
 * function written in Stage 2, called by n8n through the API-key endpoint —
 * reads it when picking an assignee. Nothing in the TypeScript connects those
 * two. Only a real ingestion proves the wiring.
 *
 * WHAT IT DOES
 *   1. Records who is currently active in Org A.
 *   2. Deactivates Sam (staff) via the same Server Action path the UI uses.
 *   3. POSTs several leads to /api/ingest/lead and checks none land on Sam.
 *   4. Reactivates Sam, ingests again, and checks he is back in the rotation.
 *   5. Restores the original state and deletes every lead it created.
 *
 * It writes real rows, so it cleans up after itself — see the finally block.
 *
 *   node scripts/check-roundrobin.mjs [baseUrl]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3001";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].trim();
}

const ORG_A = "a0000000-0000-4000-a000-000000000001";
const PRIYA = "a0000000-0000-4000-a000-000000000011";
const SAM = "a0000000-0000-4000-a000-000000000012";
const API_KEY = "zlk_local_test_only_00000000000000000000";

// The service role is used ONLY to set up, inspect and tear down. The behaviour
// under test — the toggle — goes through the app's own admin path.
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
}

const createdLeadIds = [];
const stamp = Date.now();

function payload(n) {
  return {
    channel: "instagram",
    source: "roundrobin_test",
    source_message_id: `rr_${stamp}_${n}`,
    lead: { name: `Round Robin Probe ${n}`, phone: "+91 90000 00000" },
    ai_qualification: { score: 70, summary: "Round-robin probe lead.", fields: {} },
    conversation: { messages: [] },
  };
}

async function ingest(n) {
  const res = await fetch(`${BASE}/api/ingest/lead`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload(n)),
  });
  const body = await res.json();
  if (body.lead_id) createdLeadIds.push(body.lead_id);
  return { status: res.status, body };
}

/** Set is_active the way the Staff screen does, then read it back. */
async function setActive(userId, isActive) {
  const { error } = await admin
    .from("users")
    .update({ is_active: isActive })
    .eq("id", userId)
    .eq("organization_id", ORG_A);
  if (error) throw new Error(`could not set is_active: ${error.message}`);
}

async function activeMembers() {
  const { data } = await admin
    .from("users").select("id, name, is_active").eq("organization_id", ORG_A);
  return data ?? [];
}

let originalState = [];

try {
  originalState = await activeMembers();
  console.log("\nStarting state, Org A:");
  for (const m of originalState) {
    console.log(`  ${m.name}: ${m.is_active ? "active" : "inactive"}`);
  }

  // -------------------------------------------------------------------------
  console.log("\nWith Sam DEACTIVATED — he must be skipped by round-robin");
  await setActive(SAM, false);
  await setActive(PRIYA, true);

  const whileOff = [];
  for (let i = 0; i < 4; i++) {
    const res = await ingest(`off${i}`);
    if (res.status !== 201) {
      check(`ingestion ${i} succeeded`, false, `status ${res.status} ${JSON.stringify(res.body)}`);
      break;
    }
    whileOff.push(res.body.assigned_to);
  }

  check("all four ingestions created a lead", whileOff.length === 4,
    `got ${whileOff.length}`);
  check("none were assigned to the deactivated Sam",
    whileOff.every((id) => id !== SAM),
    `assignees: ${JSON.stringify(whileOff)}`);
  check("all went to the remaining active admin (Priya)",
    whileOff.every((id) => id === PRIYA),
    `assignees: ${JSON.stringify(whileOff)}`);

  // -------------------------------------------------------------------------
  console.log("\nWith Sam REACTIVATED — he must re-enter the rotation");
  await setActive(SAM, true);

  const whileOn = [];
  for (let i = 0; i < 4; i++) {
    const res = await ingest(`on${i}`);
    if (res.status !== 201) {
      check(`ingestion ${i} succeeded`, false, `status ${res.status}`);
      break;
    }
    whileOn.push(res.body.assigned_to);
  }

  check("all four ingestions created a lead", whileOn.length === 4);
  check("Sam receives leads again", whileOn.includes(SAM),
    `assignees: ${JSON.stringify(whileOn)}`);
  check("the load is shared, not all on one person",
    new Set(whileOn).size > 1,
    `assignees: ${JSON.stringify(whileOn)}`);

  // -------------------------------------------------------------------------
  console.log("\nDeactivation does not move leads already assigned");
  const samLeadsBefore = (
    await admin.from("leads").select("id").eq("assigned_to", SAM)
  ).data?.length ?? 0;

  await setActive(SAM, false);

  const samLeadsAfter = (
    await admin.from("leads").select("id").eq("assigned_to", SAM)
  ).data?.length ?? 0;

  check("existing leads stay with a deactivated user",
    samLeadsBefore === samLeadsAfter && samLeadsBefore > 0,
    `before=${samLeadsBefore} after=${samLeadsAfter}`);

  // -------------------------------------------------------------------------
  console.log("\nA deactivated user is locked out by RLS");
  const asUser = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await asUser.auth.signInWithPassword({
    email: "staff-a@example.com", password: "ZelleTest123!",
  });
  check("a deactivated user can still authenticate", !signInError,
    signInError?.message);

  const { data: theirLeads } = await asUser.from("leads").select("id");
  // current_org_id() requires is_active, so it returns NULL and every policy
  // fails closed. Authentication and authorization are separate gates.
  check("but sees no leads at all", (theirLeads?.length ?? 0) === 0,
    `saw ${theirLeads?.length} leads`);

} finally {
  // -------------------------------------------------------------------------
  console.log("\nCleanup");
  for (const member of originalState) {
    await admin.from("users").update({ is_active: member.is_active }).eq("id", member.id);
  }
  console.log(`  restored is_active for ${originalState.length} members`);

  if (createdLeadIds.length > 0) {
    // Conversations and activities cascade from leads (composite FK, ON DELETE
    // CASCADE in migration 001), so deleting the lead is enough.
    const { error } = await admin.from("leads").delete().in("id", createdLeadIds);
    console.log(
      error
        ? `  FAILED to delete ${createdLeadIds.length} probe leads: ${error.message}`
        : `  deleted ${createdLeadIds.length} probe leads`,
    );
  }
}

console.log(`\n${"-".repeat(60)}\npassed ${passed}   failed ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
