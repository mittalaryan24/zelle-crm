/**
 * Settings and Staff write paths, exercised as real users under RLS.
 *
 * The Server Actions themselves cannot be curled — Next gives them encrypted
 * action ids — so this drives the same database operations they perform, with
 * the same anon key plus a real user JWT. A policy that blocks a legitimate
 * admin write, or permits a staff one, shows up here rather than in the browser.
 *
 * The admin-only *gate* on those actions is covered by smoke-admin.mjs at the
 * route level; what this adds is what the database itself allows underneath.
 *
 * Everything it creates, it deletes. See the finally block.
 *
 *   node scripts/check-admin-writes.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].trim();
}

const ORG_A = "a0000000-0000-4000-a000-000000000001";
const ORG_B = "b0000000-0000-4000-a000-000000000001";
const SAM = "a0000000-0000-4000-a000-000000000012";

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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();
const createdFieldIds = [];
const createdStageIds = [];
const createdInviteIds = [];

try {
  console.log("\nPriya — admin, qualification fields");
  {
    const { supabase } = await as("admin-a@example.com");

    const { data: field, error: addErr } = await supabase
      .from("qualification_field_defs")
      .insert({
        organization_id: ORG_A,
        field_key: `probe_${stamp}`.slice(0, 63),
        label: "Probe field",
        order_index: 99,
      })
      .select("id")
      .single();

    check("admin can add a qualification field", !addErr && Boolean(field?.id), addErr?.message);
    if (field?.id) createdFieldIds.push(field.id);

    if (field?.id) {
      const { error: renameErr } = await supabase
        .from("qualification_field_defs")
        .update({ label: "Probe field renamed" })
        .eq("id", field.id);
      check("admin can rename a field label", !renameErr, renameErr?.message);

      const { error: reorderErr } = await supabase
        .from("qualification_field_defs")
        .update({ order_index: 98 })
        .eq("id", field.id);
      check("admin can reorder a field", !reorderErr, reorderErr?.message);
    }

    // The key format CHECK from migration 001.
    const { error: badKeyErr } = await supabase
      .from("qualification_field_defs")
      .insert({ organization_id: ORG_A, field_key: "Not A Valid Key!", label: "x" });
    check("a malformed field_key is refused by the database", Boolean(badKeyErr));

    // Tenant isolation on writes, not just reads.
    const { error: crossOrgErr } = await supabase
      .from("qualification_field_defs")
      .insert({ organization_id: ORG_B, field_key: `evil_${stamp}`, label: "x" });
    check("admin cannot create a field in another organization", Boolean(crossOrgErr));
  }

  console.log("\nPriya — admin, pipeline stages");
  {
    const { supabase } = await as("admin-a@example.com");

    const { data: stage, error: addErr } = await supabase
      .from("pipeline_stages")
      .insert({ organization_id: ORG_A, name: `Probe ${stamp}`, order_index: 99 })
      .select("id, name")
      .single();

    check("admin can add a pipeline stage", !addErr && Boolean(stage?.id), addErr?.message);
    if (stage?.id) createdStageIds.push(stage.id);

    if (stage?.id) {
      const { error: renameErr } = await supabase
        .from("pipeline_stages").update({ name: `Probe ${stamp} renamed` }).eq("id", stage.id);
      check("admin can rename a stage", !renameErr, renameErr?.message);
    }

    // pipeline_stages_org_name_key — unique per org.
    const { error: dupErr } = await supabase
      .from("pipeline_stages").insert({ organization_id: ORG_A, name: "New", order_index: 50 });
    check("a duplicate stage name is refused", Boolean(dupErr));

    const { error: crossOrgErr } = await supabase
      .from("pipeline_stages").insert({ organization_id: ORG_B, name: `Evil ${stamp}` });
    check("admin cannot add a stage to another organization", Boolean(crossOrgErr));
  }

  console.log("\nPriya — admin, invitations");
  {
    const { supabase, userId } = await as("admin-a@example.com");

    const email = `probe.${stamp}@example.com`;
    const { data: invite, error: inviteErr } = await supabase
      .from("invitations")
      .insert({ organization_id: ORG_A, email, role: "staff", invited_by: userId })
      .select("id")
      .single();

    check("admin can create an invitation", !inviteErr && Boolean(invite?.id), inviteErr?.message);
    if (invite?.id) createdInviteIds.push(invite.id);

    // invitations_pending_unique_idx is PARTIAL — one PENDING invite per email
    // per org, but a second is allowed once the first is accepted.
    const { error: dupErr } = await supabase
      .from("invitations")
      .insert({ organization_id: ORG_A, email, role: "staff", invited_by: userId });
    check("a second pending invite for the same email is refused", Boolean(dupErr));

    const { error: crossOrgErr } = await supabase
      .from("invitations")
      .insert({ organization_id: ORG_B, email: `evil.${stamp}@example.com`, role: "admin" });
    check("admin cannot invite into another organization", Boolean(crossOrgErr));
  }

  console.log("\nSam — staff, must be refused by RLS on invitations");
  {
    const { supabase, userId } = await as("staff-a@example.com");

    const { data: visible } = await supabase.from("invitations").select("id");
    // is_org_admin() gates the invitations SELECT policy (migration 003).
    check("staff sees no invitations at all", (visible?.length ?? 0) === 0,
      `saw ${visible?.length}`);

    const { error: insertErr } = await supabase.from("invitations").insert({
      organization_id: ORG_A, email: `sneaky.${stamp}@example.com`, role: "admin",
      invited_by: userId,
    });
    // The important one: without this, a staff user could invite themselves a
    // second admin account. That is straight privilege escalation.
    check("staff cannot create an invitation", Boolean(insertErr), "the insert was allowed");
  }

  console.log("\nSam — staff, must not change roles or activation");
  {
    const { supabase, userId } = await as("staff-a@example.com");

    const { error: roleErr } = await supabase
      .from("users").update({ role: "admin" }).eq("id", userId);
    // Blocked by the users_guard_tenancy_columns trigger (migration 002),
    // not by RLS — RLS lets you update your own row.
    check("staff cannot promote themselves to admin", Boolean(roleErr), "the update was allowed");

    const { error: orgErr } = await supabase
      .from("users").update({ organization_id: ORG_B }).eq("id", userId);
    check("staff cannot move themselves to another organization", Boolean(orgErr));

    const { data: before } = await admin
      .from("users").select("is_active").eq("id", "a0000000-0000-4000-a000-000000000011").single();

    const { error: otherErr, count } = await supabase
      .from("users")
      .update({ is_active: false }, { count: "exact" })
      .eq("id", "a0000000-0000-4000-a000-000000000011"); // Priya

    const { data: after } = await admin
      .from("users").select("is_active").eq("id", "a0000000-0000-4000-a000-000000000011").single();

    // RLS on users is "update self" only, so this either errors or matches zero
    // rows. Either is a pass; what matters is Priya is untouched.
    check("staff cannot deactivate an admin",
      (Boolean(otherErr) || count === 0) && before.is_active === after.is_active,
      `error=${otherErr?.message ?? "none"} count=${count}`);
  }

  console.log("\nSam — staff, config tables are readable but that is all Stage 4 relies on");
  {
    const { supabase } = await as("staff-a@example.com");

    const { data: stages } = await supabase.from("pipeline_stages").select("id");
    const { data: fields } = await supabase.from("qualification_field_defs").select("id");

    // Deliberately readable: the Lead Profile renders both for every user. The
    // admin-only restriction is on EDITING, and that is enforced by
    // checkAdmin() in the Server Actions, not by RLS. Asserted here so the
    // design decision is visible rather than assumed.
    check("staff can read pipeline stages (the Lead Profile needs them)",
      (stages?.length ?? 0) > 0);
    check("staff can read qualification field defs (same reason)",
      (fields?.length ?? 0) > 0);
  }

} finally {
  console.log("\nCleanup");
  if (createdFieldIds.length) {
    await admin.from("qualification_field_defs").delete().in("id", createdFieldIds);
    console.log(`  deleted ${createdFieldIds.length} probe field(s)`);
  }
  if (createdStageIds.length) {
    await admin.from("pipeline_stages").delete().in("id", createdStageIds);
    console.log(`  deleted ${createdStageIds.length} probe stage(s)`);
  }
  if (createdInviteIds.length) {
    await admin.from("invitations").delete().in("id", createdInviteIds);
    console.log(`  deleted ${createdInviteIds.length} probe invitation(s)`);
  }
  // Guarantee the fixture is exactly as we found it, whatever happened above.
  await admin.from("users").update({ is_active: true }).eq("organization_id", ORG_A);
  console.log("  reasserted Org A members active");
}

console.log(`\n${"-".repeat(60)}\npassed ${passed}   failed ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
