/**
 * Signs in as each fixture user with the ANON key — exactly what the browser
 * does — and reports what RLS actually lets them read.
 *
 * This is the check that matters for Stage 3: it exercises the real client path
 * (anon key + user JWT), not the service role, so what it prints is what a user
 * could get out of the database by any means, including devtools.
 *
 *   node scripts/check-rls.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// Minimal .env.local reader — avoids a dotenv dependency for one script.
const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].trim();
}

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const USERS = [
  { label: "Priya  (Org A, admin)", email: "admin-a@example.com", org: "A", role: "admin" },
  { label: "Sam    (Org A, staff)", email: "staff-a@example.com", org: "A", role: "staff" },
  { label: "Diego  (Org B, admin)", email: "admin-b@example.com", org: "B", role: "admin" },
  { label: "Nadia  (Org B, staff)", email: "staff-b@example.com", org: "B", role: "staff" },
];

const PASSWORD = "ZelleTest123!";

// Org A's two fixture leads. Sam is assigned Alpha; Gamma is unassigned.
const LEAD_ALPHA = "a0000000-0000-4000-a000-000000000101";
const LEAD_GAMMA = "a0000000-0000-4000-a000-000000000102";
const LEAD_BETA_ORG_B = "b0000000-0000-4000-a000-000000000101";

for (const u of USERS) {
  const supabase = createClient(URL_, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: u.email,
    password: PASSWORD,
  });

  if (signInError) {
    console.log(`${u.label}  SIGN-IN FAILED: ${signInError.message}`);
    continue;
  }

  const { data: leads } = await supabase
    .from("leads")
    .select("id, name, assigned_to")
    .order("created_at", { ascending: false });

  const { data: alpha } = await supabase.from("leads").select("id").eq("id", LEAD_ALPHA);
  const { data: gamma } = await supabase.from("leads").select("id").eq("id", LEAD_GAMMA);
  const { data: beta } = await supabase.from("leads").select("id").eq("id", LEAD_BETA_ORG_B);

  // The transcript is as sensitive as the lead; check it separately, since a
  // policy that guards leads but not conversations still leaks the content.
  const { data: alphaConv } = await supabase
    .from("conversations")
    .select("id")
    .eq("lead_id", LEAD_ALPHA);

  // What SHOULD be visible, once migration 006 is applied:
  //   Org A admin -> every Org A lead, Alpha and Gamma included
  //   Org A staff -> Alpha only (assigned to Sam); Gamma is unassigned
  //   Org B users -> neither; Beta is theirs and is expected
  const crossOrg = u.org === "A" ? Boolean(beta?.length) : false;
  const expectAlpha = u.org === "A";
  const expectGamma = u.org === "A" && u.role === "admin";

  const mark = (actual, expected) =>
    actual === expected ? (actual ? "YES" : "no ") : actual ? "WIDE" : "MISS";

  console.log(
    `${u.label}  leads=${String(leads?.length ?? 0).padEnd(3)}` +
      ` alpha=${mark(Boolean(alpha?.length), expectAlpha)}` +
      ` gamma=${mark(Boolean(gamma?.length), expectGamma)}` +
      ` transcript=${mark(Boolean(alphaConv?.length), expectAlpha)}` +
      ` cross_org=${crossOrg ? "LEAK!" : "no "}`,
  );

  await supabase.auth.signOut();
}
