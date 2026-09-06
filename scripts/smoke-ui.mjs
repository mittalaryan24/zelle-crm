/**
 * End-to-end UI smoke test.
 *
 * Signs in through the Supabase auth API, builds the session cookie exactly as
 * @supabase/ssr writes it, then fetches the real pages from the dev server and
 * asserts on the rendered HTML. This is the closest thing to clicking through
 * the app that can run unattended.
 *
 *   node scripts/smoke-ui.mjs [baseUrl]
 */
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3001";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].trim();
}
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];

const LEAD_ALPHA = "a0000000-0000-4000-a000-000000000101"; // Org A, assigned to Sam
const LEAD_GAMMA = "a0000000-0000-4000-a000-000000000102"; // Org A, unassigned
const LEAD_BETA = "b0000000-0000-4000-a000-000000000101"; // Org B

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Sign in and return the Cookie header @supabase/ssr would have set. */
async function signIn(email, password) {
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
  );
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${await res.text()}`);
  const session = await res.json();

  // @supabase/ssr stores the whole session as base64url'd JSON behind a
  // "base64-" prefix, in a cookie named sb-<project-ref>-auth-token. Chunking
  // kicks in past ~3600 bytes; these sessions are well under that.
  const encoded =
    "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `sb-${PROJECT_REF}-auth-token=${encoded}`;
}

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
}

// ---------------------------------------------------------------------------

console.log("\nUnauthenticated");
{
  const leads = await get("/leads");
  check("/leads redirects to /login", leads.status === 307 && leads.location?.includes("/login"),
    `got ${leads.status} ${leads.location}`);

  const profile = await get(`/leads/${LEAD_ALPHA}`);
  check("a lead URL redirects to /login", profile.status === 307 && profile.location?.includes("/login"),
    `got ${profile.status}`);

  const login = await get("/login");
  check("/login renders", login.status === 200 && login.html.includes("Sign in"));
}

console.log("\nSam — staff, Org A");
{
  const cookie = await signIn("staff-a@example.com", "ZelleTest123!");

  const inbox = await get("/leads", cookie);
  check("inbox renders", inbox.status === 200 && inbox.html.includes("Lead Inbox"));
  check("header shows the Staff badge", inbox.html.includes("Staff"));
  check("staff sees the staff-scoped subtitle",
    inbox.html.includes("Leads assigned to you"));
  check("no Assigned Staff column for staff", !inbox.html.includes("Assigned staff"));
  check("no Unassigned filter for staff", !inbox.html.includes("Unassigned only"));
  check("inbox shows Lead Alpha (assigned to Sam)", inbox.html.includes("Lead Alpha"));
  check("inbox hides Lead Gamma (unassigned)", !inbox.html.includes("Lead Gamma"));

  const alpha = await get(`/leads/${LEAD_ALPHA}`, cookie);
  check("can open own lead", alpha.status === 200 && alpha.html.includes("Lead Alpha"));
  check("profile shows the AI score", alpha.html.includes("82"));
  check("qualification labels come from field defs",
    alpha.html.includes("Fitness goal") && alpha.html.includes("Monthly budget"));
  check("WhatsApp link is digits-only",
    alpha.html.includes("wa.me/919820011111"),
    "expected the formatting stripped from '+91 98200 11111'");
  check("tel: link present", alpha.html.includes('href="tel:+919820011111"'));
  check("no Instagram action button", !alpha.html.toLowerCase().includes(">instagram</a>"));
  check("activity renders as prose, not JSON",
    alpha.html.includes("Status changed from New to Qualified"));
  check("activity shows the actor", alpha.html.includes("AI assistant"));

  const gamma = await get(`/leads/${LEAD_GAMMA}`, cookie);
  check("unassigned lead is not openable by staff",
    gamma.html.includes("Lead not available"),
    `status ${gamma.status}`);

  const beta = await get(`/leads/${LEAD_BETA}`, cookie);
  check("Org B lead is not openable (cross-tenant)",
    beta.html.includes("Lead not available") && !beta.html.includes("Lead Beta"),
    `status ${beta.status}`);
}

console.log("\nPriya — admin, Org A");
{
  const cookie = await signIn("admin-a@example.com", "ZelleTest123!");

  const inbox = await get("/leads", cookie);
  check("inbox renders", inbox.status === 200 && inbox.html.includes("Lead Inbox"));
  check("header shows the Admin badge", inbox.html.includes("Admin"));
  check("admin sees the org-wide subtitle",
    inbox.html.includes("Every lead in your organization"));
  check("Assigned Staff column present", inbox.html.includes("Assigned staff"));
  check("Unassigned filter present", inbox.html.includes("Unassigned only"));
  check("admin sees Lead Alpha", inbox.html.includes("Lead Alpha"));
  check("admin sees Lead Gamma (unassigned)", inbox.html.includes("Lead Gamma"));
  check("reassign control present", inbox.html.includes("Reassign"));

  const unassigned = await get("/leads?unassigned=1", cookie);
  check("Unassigned filter shows Gamma", unassigned.html.includes("Lead Gamma"));
  check("Unassigned filter hides assigned Alpha", !unassigned.html.includes("Lead Alpha"));

  const search = await get("/leads?q=Gamma", cookie);
  check("search by name works", search.html.includes("Lead Gamma") && !search.html.includes("Lead Alpha"));

  const channel = await get("/leads?channel=whatsapp", cookie);
  check("channel filter works", channel.html.includes("Lead Gamma") && !channel.html.includes("Lead Alpha"));

  const score = await get("/leads?score=80-100", cookie);
  check("score filter works", score.html.includes("Lead Alpha") && !score.html.includes("Lead Gamma"));

  const gamma = await get(`/leads/${LEAD_GAMMA}`, cookie);
  check("admin can open the unassigned lead", gamma.status === 200 && gamma.html.includes("Lead Gamma"));

  const beta = await get(`/leads/${LEAD_BETA}`, cookie);
  check("admin still cannot open an Org B lead",
    beta.html.includes("Lead not available") && !beta.html.includes("Lead Beta"),
    `status ${beta.status}`);
}

console.log("\nDiego — admin, Org B");
{
  const cookie = await signIn("admin-b@example.com", "ZelleTest123!");

  const inbox = await get("/leads", cookie);
  check("sees Org B leads", inbox.html.includes("Lead Beta"));
  check("cannot see Org A leads",
    !inbox.html.includes("Lead Alpha") && !inbox.html.includes("Lead Gamma"));
  check("sees Org B qualification vocabulary, not Org A's",
    !inbox.html.includes("Fitness goal"));

  const alpha = await get(`/leads/${LEAD_ALPHA}`, cookie);
  check("cannot open an Org A lead",
    alpha.html.includes("Lead not available") && !alpha.html.includes("Lead Alpha"));
}

console.log(`\n${"-".repeat(60)}\npassed ${passed}   failed ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
