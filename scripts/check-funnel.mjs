/**
 * Unit tests for the funnel maths in src/lib/funnel.ts.
 *
 * These are the only tests in the project that touch neither the database nor
 * the dev server. That is the point: the "reached a stage" definition is the
 * subtlest thing in Stage 4, and against fixed inputs its edge cases can be
 * pinned down exactly — which is impossible against live fixture data that
 * shifts every time someone clicks something.
 *
 * Run with Node's TypeScript stripping (Node 22.18+):
 *
 *   node --experimental-strip-types scripts/check-funnel.mjs
 *
 * The funnel module only imports types from elsewhere, and `import type` is
 * erased by the stripper, so nothing needs a bundler or a path-alias resolver.
 */
import {
  buildFunnel,
  buildStaffFunnel,
  buildTrend,
  reachedStagesByLead,
  resolveMetricStage,
} from "../src/lib/funnel.ts";

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
}

const STAGES = [
  { id: "s1", name: "New", order_index: 0 },
  { id: "s2", name: "Contacted", order_index: 1 },
  { id: "s3", name: "Qualified", order_index: 2 },
  { id: "s4", name: "Won", order_index: 3 },
  { id: "s5", name: "Lost", order_index: 4 },
];

const lead = (id, status, assigned_to = null, created_at = "2026-09-01T10:00:00Z") => ({
  id, status, assigned_to, created_at,
  organization_id: "org", name: id, phone: null, channel: "instagram",
  source: null, ai_score: 50, ai_summary: null, qualification_data: {},
  source_message_id: null, updated_at: created_at,
});

const statusChange = (lead_id, content) => ({
  id: `a-${lead_id}-${Math.random()}`, lead_id, actor_type: "user", actor_id: "u1",
  type: "status_change", content, created_at: "2026-09-01T11:00:00Z", actor_name: null,
});

// ---------------------------------------------------------------------------
console.log("\nreachedStagesByLead — the core definition");
{
  // A lead that went New -> Contacted -> Lost. It reached Contacted, even
  // though its current status is Lost. This is the whole reason the funnel is
  // built from activities rather than from leads.status.
  const leads = [lead("L1", "Lost")];
  const activities = [
    statusChange("L1", { old_status: "New", new_status: "Contacted" }),
    statusChange("L1", { old_status: "Contacted", new_status: "Lost" }),
  ];
  const reached = reachedStagesByLead(leads, activities, STAGES).get("L1");

  check("counts the stage it currently sits in", reached.has("lost"));
  check("counts a stage it passed through and left", reached.has("contacted"));
  check("counts the origin of a transition", reached.has("new"));
  check("does not invent stages it never touched", !reached.has("qualified"));
}

{
  // The older { from, to } shape, written by the Stage 1 fixture and by n8n.
  // Both shapes are live in the database right now.
  const leads = [lead("L2", "Qualified")];
  const activities = [statusChange("L2", { from: "New", to: "Qualified" })];
  const reached = reachedStagesByLead(leads, activities, STAGES).get("L2");

  check("reads the legacy { from, to } content shape",
    reached.has("new") && reached.has("qualified"));
}

{
  // A lead with no status_change activity at all — the ingestion path, which
  // writes ai_qualified instead. It must still count at the top of the funnel.
  const leads = [lead("L3", "New")];
  const reached = reachedStagesByLead(leads, [], STAGES).get("L3");

  check("a lead with no activities still reaches the first stage",
    reached.has("new") && reached.size === 1);
}

{
  // Case and whitespace differences between leads.status (free text) and
  // pipeline_stages.name must not split a stage in two.
  const leads = [lead("L4", "  QUALIFIED ")];
  const reached = reachedStagesByLead(leads, [], STAGES).get("L4");
  check("stage matching is case- and whitespace-insensitive", reached.has("qualified"));
}

{
  // An activity referencing a lead outside the set must not create a phantom.
  const leads = [lead("L5", "New")];
  const activities = [statusChange("GHOST", { new_status: "Won" })];
  const map = reachedStagesByLead(leads, activities, STAGES);
  check("ignores activities for leads not in the set", map.size === 1 && !map.has("GHOST"));
}

// ---------------------------------------------------------------------------
console.log("\nbuildFunnel");
{
  const leads = [
    lead("A", "Won"),       // reached New, Contacted, Qualified, Won
    lead("B", "Contacted"), // reached New, Contacted
    lead("C", "New"),       // reached New
  ];
  const activities = [
    statusChange("A", { old_status: "New", new_status: "Contacted" }),
    statusChange("A", { old_status: "Contacted", new_status: "Qualified" }),
    statusChange("A", { old_status: "Qualified", new_status: "Won" }),
    statusChange("B", { old_status: "New", new_status: "Contacted" }),
  ];

  const funnel = buildFunnel(leads, activities, STAGES);
  const by = Object.fromEntries(funnel.map((f) => [f.stage, f.reached]));

  check("every lead reaches the first stage", by["New"] === 3, `got ${by["New"]}`);
  check("Contacted counts both that got there", by["Contacted"] === 2, `got ${by["Contacted"]}`);
  check("Qualified counts only the one", by["Qualified"] === 1, `got ${by["Qualified"]}`);
  check("Won counts only the one", by["Won"] === 1, `got ${by["Won"]}`);
  check("Lost counts nobody", by["Lost"] === 0, `got ${by["Lost"]}`);

  check("rows come back in order_index order",
    funnel.map((f) => f.stage).join(",") === "New,Contacted,Qualified,Won,Lost");
  check("the widest step is 100%", funnel[0].percentOfTop === 100);
  check("no bar exceeds 100%", funnel.every((f) => f.percentOfTop <= 100));

  // A pipeline where the largest count is not the first stage — clients can put
  // stages in any order, and dividing by the first would overflow the bar.
  const oddStages = [
    { id: "x1", name: "Triage", order_index: 0 },
    { id: "x2", name: "Open", order_index: 1 },
  ];
  const oddFunnel = buildFunnel([lead("Z", "Open")], [], oddStages);
  check("handles a first stage that is not the widest",
    oddFunnel.every((f) => f.percentOfTop <= 100));
}

{
  const empty = buildFunnel([], [], STAGES);
  check("no leads gives every stage a zero, not a crash",
    empty.length === 5 && empty.every((f) => f.reached === 0));
  check("no stages gives an empty funnel", buildFunnel([lead("A", "New")], [], []).length === 0);
}

// ---------------------------------------------------------------------------
console.log("\nresolveMetricStage — named cards onto configured stages");
{
  check("Qualified matches directly",
    resolveMetricStage(STAGES, "qualified")?.name === "Qualified");
  check("Converted matches the default stage named Won",
    resolveMetricStage(STAGES, "converted")?.name === "Won");
  check("Contacted matches directly",
    resolveMetricStage(STAGES, "contacted")?.name === "Contacted");

  const renamed = [{ id: "r1", name: "Closed Won", order_index: 0 }];
  check("Converted also matches 'Closed Won'",
    resolveMetricStage(renamed, "converted")?.name === "Closed Won");

  const nothing = [{ id: "n1", name: "Bananas", order_index: 0 }];
  check("returns null when no stage maps — so the card shows a dash, not a zero",
    resolveMetricStage(nothing, "converted") === null);
}

// ---------------------------------------------------------------------------
console.log("\nbuildStaffFunnel");
{
  const leads = [
    lead("A", "Won", "sam"),
    lead("B", "Contacted", "sam"),
    lead("C", "New", "priya"),
    lead("D", "New", null),
  ];
  const activities = [
    statusChange("A", { old_status: "Contacted", new_status: "Won" }),
    statusChange("B", { old_status: "New", new_status: "Contacted" }),
  ];
  const members = [
    { id: "sam", name: "Sam", email: "s@x.com", is_active: true },
    { id: "priya", name: "Priya", email: "p@x.com", is_active: true },
  ];

  const rows = buildStaffFunnel(leads, activities, STAGES, members);
  const sam = rows.find((r) => r.userId === "sam");
  const priya = rows.find((r) => r.userId === "priya");
  const unassigned = rows.find((r) => r.userId === null);

  check("counts assigned leads per person", sam.assigned === 2 && priya.assigned === 1);
  check("counts contacted per person", sam.contacted === 2, `got ${sam.contacted}`);
  check("counts converted per person", sam.converted === 1, `got ${sam.converted}`);
  check("the unassigned backlog gets its own row", unassigned?.assigned === 1);
  check("unassigned sorts last", rows[rows.length - 1].userId === null);

  // A member with no leads must still appear, or the Staff screen would drop
  // people from the roster the moment they had a quiet week.
  const withIdle = buildStaffFunnel([], [], STAGES, members);
  check("members with zero leads still appear", withIdle.length === 2);

  // A lead assigned to someone not in the members list — a deleted account, or
  // a row RLS hides. Must not be silently merged into "Unassigned".
  const orphan = buildStaffFunnel([lead("E", "New", "ghost")], [], STAGES, members);
  check("a lead owned by a non-member is labelled distinctly",
    orphan.find((r) => r.userId === "ghost")?.name === "Former member");

  // No stage maps to Converted -> null, not 0, all the way through.
  const noStages = [{ id: "q", name: "Bananas", order_index: 0 }];
  const nullRows = buildStaffFunnel(leads, activities, noStages, members);
  check("unmappable metrics stay null per staff row",
    nullRows.every((r) => r.converted === null && r.contacted === null));
}

// ---------------------------------------------------------------------------
console.log("\nbuildTrend");
{
  const today = new Date();
  const iso = (daysAgo) => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
  };

  const leads = [
    lead("A", "New", null, iso(0)),
    lead("B", "New", null, iso(0)),
    lead("C", "New", null, iso(5)),
    lead("D", "New", null, iso(100)), // outside the window
  ];

  const trend = buildTrend(leads, 30);
  check("emits one point per day in the window", trend.length === 30);
  check("includes days with zero leads", trend.some((p) => p.count === 0));
  check("today's bucket has both of today's leads",
    trend[trend.length - 1].count === 2, `got ${trend[trend.length - 1].count}`);
  check("counts only leads inside the window",
    trend.reduce((s, p) => s + p.count, 0) === 3);
  check("points are in chronological order",
    trend.every((p, i) => i === 0 || p.date > trend[i - 1].date));

  check("an empty lead list still emits the full window",
    buildTrend([], 30).length === 30);
  check("a malformed created_at is skipped, not counted as NaN",
    buildTrend([lead("X", "New", null, "not-a-date")], 30)
      .every((p) => p.count === 0));
}

console.log(`\n${"-".repeat(60)}\npassed ${passed}   failed ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
