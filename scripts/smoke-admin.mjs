/**
 * Stage 4 UI smoke test — admin screens.
 *
 * Same pattern as smoke-ui.mjs: signs in through the auth API, builds the
 * session cookie @supabase/ssr writes, fetches the real pages and asserts on
 * rendered HTML.
 *
 * Covers the three things the brief asks for on the UI side:
 *   - a staff user cannot reach any admin route
 *   - dashboard numbers are scoped to the caller's own organization
 *   - the screens render the data they claim to
 *
 *   node scripts/smoke-admin.mjs [baseUrl]
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

const ADMIN_ROUTES = ["/dashboard", "/staff", "/settings"];

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function signIn(email, password = "ZelleTest123!") {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${await res.text()}`);
  const session = await res.json();
  const encoded = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `sb-${PROJECT_REF}-auth-token=${encoded}`;
}

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  const html = await res.text();
  return {
    status: res.status,
    location: res.headers.get("location"),
    html,
    // React's server renderer splits adjacent text children with `<!-- -->`
    // markers, so `{count} {"lead"}` reaches the wire as `1<!-- --> <!-- -->lead`.
    // Any assertion about text that spans an interpolation has to read this
    // stripped copy, or it fails on markup that is actually correct.
    text: html.replace(/<!--[\s\S]*?-->/g, ""),
  };
}

/** Pull an integer out of a metric card by its label. */
function cardValue(html, label) {
  // The card renders: <div ...>LABEL</div><div ...><span ...>N</span></div>
  const idx = html.indexOf(`>${label}</div>`);
  if (idx === -1) return null;
  const after = html.slice(idx, idx + 600);
  const m = /tabular-nums[^>]*>([\d,]+)</.exec(after);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

// ---------------------------------------------------------------------------

console.log("\nUnauthenticated — admin routes are gated");
{
  for (const route of ADMIN_ROUTES) {
    const res = await get(route);
    check(`${route} redirects to /login`,
      res.status === 307 && res.location?.includes("/login"),
      `got ${res.status} ${res.location}`);
  }
}

console.log("\nSam — STAFF, must not reach any admin route");
{
  const cookie = await signIn("staff-a@example.com");

  for (const route of ADMIN_ROUTES) {
    const res = await get(route, cookie);
    // requireAdmin() redirects to /leads. A 200 here would mean the page
    // rendered for a staff user, which is the failure this test exists for.
    const bounced = res.status === 307 && (res.location ?? "").endsWith("/leads");
    check(`${route} bounces a staff user to /leads`, bounced,
      `got ${res.status} ${res.location ?? ""}`);
  }

  // The nav must not advertise them either.
  const inbox = await get("/leads", cookie);
  check("nav hides Dashboard for staff", !inbox.html.includes(">Dashboard</a>"));
  check("nav hides Staff for staff", !inbox.html.includes(">Staff</a>"));
  check("nav hides Settings for staff", !inbox.html.includes(">Settings</a>"));
  check("nav still shows Inbox", inbox.html.includes(">Inbox</a>"));
}

console.log("\nPriya — ADMIN, Org A");
let orgADashboard = "";
{
  const cookie = await signIn("admin-a@example.com");

  const dash = await get("/dashboard", cookie);
  orgADashboard = dash.html;
  check("dashboard renders", dash.status === 200 && dash.html.includes("Dashboard"));
  check("scoped to Acme Fitness Studio", dash.html.includes("Acme Fitness Studio"));

  check("has all five metric cards",
    ["Total leads", "Qualified", "Assigned", "Contacted", "Converted"]
      .every((l) => dash.html.includes(`>${l}</div>`)));

  check("bot performance section present", dash.html.includes("Bot performance"));
  check("staff performance section present", dash.html.includes("Staff performance"));
  check("qualification rate is shown", dash.html.includes("Qualification rate"));
  check("qualification rate divides by conversations",
    dash.html.includes("conversations"));
  check("meetings is declared untracked, not zero",
    dash.html.includes("Not tracked yet"));

  check("funnel uses this org's stage names",
    ["New", "Contacted", "Qualified", "Won", "Lost"].every((s) => dash.html.includes(s)));
  check("lead trend rendered", dash.html.includes("Lead trend"));
  check("staff breakdown rendered", dash.html.includes("Staff breakdown"));
  check("recent leads reuses the inbox table",
    dash.html.includes("Recent leads") && dash.html.includes("AI summary"));

  const total = cardValue(dash.html, "Total leads");
  check("Total leads is a real number > 0", typeof total === "number" && total > 0,
    `got ${total}`);

  const staff = await get("/staff", cookie);
  check("staff page renders", staff.status === 200 && staff.html.includes("Team"));
  check("lists Priya and Sam",
    staff.html.includes("Priya Sharma") && staff.html.includes("Sam Okafor"));
  check("shows the invite form", staff.html.includes("Invite a colleague"));
  check("explains how signup completes",
    staff.html.includes("handle_new_user") && staff.html.includes("No email is sent yet"));
  check("has an activate/deactivate control", staff.html.includes("Deactivate"));

  const settings = await get("/settings", cookie);
  check("settings renders", settings.status === 200);
  check("lists Org A qualification fields",
    settings.html.includes("Fitness goal") && settings.html.includes("budget_month"));
  check("lists pipeline stages", settings.html.includes("Pipeline stages"));
  check("shows lead counts per stage for the orphan warning",
    /\d+\s+leads?</.test(settings.text));
}

console.log("\nDiego — ADMIN, Org B — org scoping of the numbers");
{
  const cookie = await signIn("admin-b@example.com");

  const dash = await get("/dashboard", cookie);
  check("dashboard renders for Org B", dash.status === 200);
  check("scoped to Bright Smile Dental", dash.html.includes("Bright Smile Dental"));
  check("does not name Org A", !dash.html.includes("Acme Fitness Studio"));
  check("does not show Org A leads",
    !dash.html.includes("Lead Alpha") && !dash.html.includes("Lead Gamma"));
  check("shows Org B's own lead", dash.html.includes("Lead Beta"));

  const orgATotal = cardValue(orgADashboard, "Total leads");
  const orgBTotal = cardValue(dash.html, "Total leads");
  check("the two orgs report different totals",
    orgATotal !== null && orgBTotal !== null && orgATotal !== orgBTotal,
    `Org A=${orgATotal} Org B=${orgBTotal}`);
  check("Org B total matches its 2 fixture leads", orgBTotal === 2, `got ${orgBTotal}`);

  const staff = await get("/staff", cookie);
  check("staff page lists only Org B members",
    staff.html.includes("Diego Ramos") &&
      staff.html.includes("Nadia Haddad") &&
      !staff.html.includes("Sam Okafor"));

  const settings = await get("/settings", cookie);
  check("settings shows Org B's own field vocabulary",
    settings.html.includes("Treatment interest") && !settings.html.includes("Fitness goal"));
}

console.log("\nNadia — STAFF, Org B");
{
  const cookie = await signIn("staff-b@example.com");
  for (const route of ADMIN_ROUTES) {
    const res = await get(route, cookie);
    check(`${route} bounces Org B staff too`,
      res.status === 307 && (res.location ?? "").endsWith("/leads"),
      `got ${res.status} ${res.location ?? ""}`);
  }
}

console.log(`\n${"-".repeat(60)}\npassed ${passed}   failed ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
