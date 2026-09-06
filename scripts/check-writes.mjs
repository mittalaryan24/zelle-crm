/**
 * Exercises the write paths the Lead Profile uses, as a real user under RLS.
 *
 * The UI smoke test cannot reach these: Server Actions are POST endpoints with
 * an encrypted action id, not something to curl. This drives the same database
 * operations the actions perform, with the same anon key + user JWT, so a policy
 * that blocks a legitimate write shows up here rather than in the browser.
 *
 *   node scripts/check-writes.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].trim();
}

const LEAD_ALPHA = "a0000000-0000-4000-a000-000000000101"; // assigned to Sam
const LEAD_GAMMA = "a0000000-0000-4000-a000-000000000102"; // unassigned, Org A
const ORG_A = "a0000000-0000-4000-a000-000000000001";

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function as(email) {
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({
    email, password: "ZelleTest123!",
  });
  if (error) throw new Error(`${email}: ${error.message}`);
  return { supabase, userId: data.user.id };
}

console.log("\nSam — staff, on his own lead (Alpha)");
{
  const { supabase, userId } = await as("staff-a@example.com");

  const { data: before } = await supabase.from("leads").select("status").eq("id", LEAD_ALPHA).single();

  const { error: statusErr } = await supabase
    .from("leads").update({ status: "Contacted" }).eq("id", LEAD_ALPHA);
  check("can change the status of his own lead", !statusErr, statusErr?.message);

  const { error: activityErr } = await supabase.from("activities").insert({
    organization_id: ORG_A, lead_id: LEAD_ALPHA,
    actor_type: "user", actor_id: userId, type: "status_change",
    content: { old_status: before?.status, new_status: "Contacted" },
  });
  check("can append a status_change activity", !activityErr, activityErr?.message);

  const { error: noteErr } = await supabase.from("activities").insert({
    organization_id: ORG_A, lead_id: LEAD_ALPHA,
    actor_type: "user", actor_id: userId, type: "note",
    content: { text: "check-writes.mjs smoke note" },
  });
  check("can add a note", !noteErr, noteErr?.message);

  const { error: followErr } = await supabase.from("activities").insert({
    organization_id: ORG_A, lead_id: LEAD_ALPHA,
    actor_type: "user", actor_id: userId, type: "follow_up_set",
    content: { follow_up_date: new Date(Date.now() + 864e5).toISOString(), note: "smoke" },
  });
  check("can set a follow-up", !followErr, followErr?.message);

  // Restore, so re-running the script is idempotent on the lead itself.
  await supabase.from("leads").update({ status: before?.status ?? "Qualified" }).eq("id", LEAD_ALPHA);

  // The audit trail forbids UPDATE and DELETE outright (migration 003). Both
  // should be refused, or silently affect zero rows — either is a pass, since
  // neither changes anything.
  const { data: anyActivity } = await supabase
    .from("activities").select("id").eq("lead_id", LEAD_ALPHA).limit(1).maybeSingle();
  const { error: tamperErr, count } = await supabase
    .from("activities").update({ content: { text: "tampered" } }, { count: "exact" })
    .eq("id", anyActivity?.id ?? "00000000-0000-0000-0000-000000000000");
  check("cannot rewrite the audit trail", Boolean(tamperErr) || count === 0,
    `error=${tamperErr?.message ?? "none"} count=${count}`);

  // Attribution is enforced by the RLS WITH CHECK, not by the app.
  const { error: spoofErr } = await supabase.from("activities").insert({
    organization_id: ORG_A, lead_id: LEAD_ALPHA,
    actor_type: "user", actor_id: "a0000000-0000-4000-a000-000000000011", // Priya
    type: "note", content: { text: "spoofed" },
  });
  check("cannot log an activity as someone else", Boolean(spoofErr), "insert was allowed");

  // Reassignment is an application-layer rule. Without migration 006 the UPDATE
  // policy is org-wide, so this may well succeed at the database level — the
  // Server Action is what refuses it. Reported either way.
  //
  // NOTE: this probe WRITES to a fixture row, so it must put it back. An earlier
  // version did not, which left Lead Gamma assigned to Sam and quietly broke
  // three assertions in smoke-ui.mjs on the next run — the unassigned queue is
  // fixture state that other tests depend on.
  const { data: gammaBefore } = await supabase
    .from("leads").select("assigned_to").eq("id", LEAD_GAMMA).maybeSingle();

  // COUNT, NOT ERROR. An UPDATE whose USING clause matches no row is not an
  // error in Postgres — it simply affects zero rows, and PostgREST returns 204
  // with error=null. Reading only `error` therefore reports a *blocked* write as
  // an allowed one, which is exactly how this line came to claim migration 006
  // was unapplied on a database where it was applied and working.
  const { error: reassignErr, count: reassignCount } = await supabase
    .from("leads")
    .update({ assigned_to: userId }, { count: "exact" })
    .eq("id", LEAD_GAMMA);

  const wrote = !reassignErr && (reassignCount ?? 0) > 0;
  check(
    "staff cannot write to an unassigned lead (migration 006)",
    !wrote,
    `error=${reassignErr?.code ?? "none"} rows=${reassignCount}`,
  );

  if (wrote) {
    const { error: restoreErr } = await supabase
      .from("leads")
      .update({ assigned_to: gammaBefore?.assigned_to ?? null })
      .eq("id", LEAD_GAMMA);
    check("restored Lead Gamma to unassigned", !restoreErr, restoreErr?.message);
  }
}

console.log("\nPriya — admin, reassignment");
{
  const { supabase } = await as("admin-a@example.com");
  const SAM = "a0000000-0000-4000-a000-000000000012";

  const { data: before } = await supabase.from("leads").select("assigned_to").eq("id", LEAD_GAMMA).single();

  const { error: assignErr } = await supabase
    .from("leads").update({ assigned_to: SAM }).eq("id", LEAD_GAMMA);
  check("admin can reassign a lead", !assignErr, assignErr?.message);

  const { error: unassignErr } = await supabase
    .from("leads").update({ assigned_to: before?.assigned_to ?? null }).eq("id", LEAD_GAMMA);
  check("admin can restore the previous assignee", !unassignErr, unassignErr?.message);

  // The composite FK leads_assigned_to_fkey is what makes a cross-org assignee
  // impossible, independently of any application check.
  const { error: crossOrgErr } = await supabase
    .from("leads")
    .update({ assigned_to: "b0000000-0000-4000-a000-000000000012" }) // Nadia, Org B
    .eq("id", LEAD_GAMMA);
  check("cannot assign a lead to someone in another org", Boolean(crossOrgErr),
    "the update was allowed");
}

console.log(`\n${"-".repeat(60)}\npassed ${passed}   failed ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
