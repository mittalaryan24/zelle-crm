import type { Activity, Lead, PipelineStage } from "@/lib/types";

/**
 * FUNNEL MATHS — pure functions, no I/O.
 *
 * Kept separate from the queries in src/lib/data/admin.ts for two reasons: the
 * dashboard and the staff-management screen both need the same numbers (the
 * brief is explicit that these must not be duplicated), and pure functions can
 * be tested against fixed inputs without a database.
 *
 * THE CENTRAL DEFINITION: "REACHED"
 * ---------------------------------
 * The brief asks for leads that *reached* each stage, not leads *currently in*
 * it. A lead that was Contacted in March and marked Lost in April still reached
 * Contacted, and a funnel built from `leads.status` would forget that — it would
 * show the pipeline emptying out over time rather than showing throughput.
 *
 * So a lead counts as having reached stage X if ANY of these hold:
 *
 *   1. Its current status is X.
 *   2. Some status_change activity names X as the destination
 *      (`new_status`, or `to` in the older shape n8n and the Stage 1 fixture
 *      write — see describeActivity() for why both exist).
 *   3. Some status_change activity names X as the *origin* (`old_status` / `from`).
 *      If a lead moved New -> Qualified, it was demonstrably in New, even though
 *      no activity records it arriving there.
 *   4. X is the first stage by order_index. Every lead is created at the first
 *      stage, and ingest_lead() does exactly that — so the top of the funnel is
 *      "every lead", which is what makes the drop-off percentages meaningful.
 *
 * Rule 3 is the one that is easy to miss, and without it the first stage after
 * creation is systematically undercounted.
 *
 * WHAT THIS CANNOT SEE
 * A status set directly in SQL with no activity row written is invisible to
 * rules 2 and 3, and only rule 1 will catch it — so it counts for the lead's
 * current stage but not for stages it passed through silently. Every write path
 * in the app records an activity, so this only affects hand-edited data.
 */

/** Case-insensitive, whitespace-tolerant stage name key. */
function stageKey(name: string): string {
  return name.trim().toLowerCase();
}

function readStatusChange(activity: Activity): { from: string | null; to: string | null } {
  const c = activity.content ?? {};
  const str = (k: string) =>
    typeof c[k] === "string" && c[k] !== "" ? (c[k] as string) : null;
  return {
    from: str("old_status") ?? str("from"),
    to: str("new_status") ?? str("to"),
  };
}

/**
 * For each lead, the set of stage names it has ever reached.
 * Returns a Map keyed by lead id.
 */
export function reachedStagesByLead(
  leads: Lead[],
  activities: Activity[],
  stages: PipelineStage[],
): Map<string, Set<string>> {
  const firstStage = [...stages].sort((a, b) => a.order_index - b.order_index)[0];

  const byLead = new Map<string, Set<string>>();
  for (const lead of leads) {
    const reached = new Set<string>();
    // Rule 1 and rule 4.
    if (lead.status) reached.add(stageKey(lead.status));
    if (firstStage) reached.add(stageKey(firstStage.name));
    byLead.set(lead.id, reached);
  }

  // Rules 2 and 3.
  for (const activity of activities) {
    if (activity.type !== "status_change") continue;
    const reached = byLead.get(activity.lead_id);
    // An activity for a lead outside this set (filtered out, or not visible
    // under RLS) is skipped rather than creating a phantom entry.
    if (!reached) continue;

    const { from, to } = readStatusChange(activity);
    if (from) reached.add(stageKey(from));
    if (to) reached.add(stageKey(to));
  }

  return byLead;
}

export interface FunnelStep {
  stage: string;
  order_index: number;
  reached: number;
  /** Percentage of the widest step, for bar widths. 0-100. */
  percentOfTop: number;
}

/**
 * The org-wide funnel: one row per configured stage, in order_index order.
 *
 * Stage names come entirely from the caller's pipeline_stages rows — nothing is
 * hardcoded, so a client who renames "Qualified" to "Assessed" gets a funnel
 * that says Assessed with no code change.
 */
export function buildFunnel(
  leads: Lead[],
  activities: Activity[],
  stages: PipelineStage[],
): FunnelStep[] {
  const byLead = reachedStagesByLead(leads, activities, stages);
  const ordered = [...stages].sort((a, b) => a.order_index - b.order_index);

  const counts = ordered.map((stage) => {
    const key = stageKey(stage.name);
    let reached = 0;
    for (const set of byLead.values()) if (set.has(key)) reached++;
    return { stage: stage.name, order_index: stage.order_index, reached };
  });

  // Percentages are relative to the widest step rather than to the first one.
  // The stages are configurable and not guaranteed monotonic — a client can put
  // "Lost" anywhere — so dividing by the first stage could produce bars over
  // 100% wide. Dividing by the maximum cannot.
  const top = Math.max(1, ...counts.map((c) => c.reached));

  return counts.map((c) => ({ ...c, percentOfTop: Math.round((c.reached / top) * 100) }));
}

/**
 * Resolving the named metric cards to actual stages.
 *
 * The brief asks for cards labelled Qualified, Contacted and Converted, while
 * also insisting the funnel not hardcode stage names. Those pull in opposite
 * directions, and this is the seam between them: the funnel stays fully dynamic,
 * and only these three named cards try to map a concept onto a configured stage.
 *
 * The match is by alias, case-insensitively. "Converted" is the interesting one
 * — the default stage set from migration 004 calls it "Won", and different
 * clients say Won, Converted, or Closed Won for the same thing.
 *
 * When nothing matches, the resolver returns null and the card renders as "not
 * configured" rather than as 0. A zero is a claim about the business ("nobody
 * converted"); null is a claim about the setup ("no stage means converted
 * here"). Showing the first when you mean the second is how a dashboard loses
 * a client's trust.
 */
const METRIC_ALIASES: Record<"contacted" | "qualified" | "converted", string[]> = {
  contacted: ["contacted", "in contact", "reached out", "engaged"],
  qualified: ["qualified", "qualification", "assessed"],
  converted: ["converted", "won", "closed won", "closed-won", "customer", "signed"],
};

export function resolveMetricStage(
  stages: PipelineStage[],
  metric: keyof typeof METRIC_ALIASES,
): PipelineStage | null {
  const aliases = METRIC_ALIASES[metric];
  return (
    stages.find((s) => aliases.includes(stageKey(s.name))) ?? null
  );
}

export interface StaffFunnelRow {
  userId: string | null;
  name: string;
  isActive: boolean;
  assigned: number;
  contacted: number | null;
  converted: number | null;
}

/**
 * The same funnel, grouped by assigned_to.
 *
 * Used by BOTH the dashboard's staff-breakdown section and the Staff Management
 * screen's inline performance columns — one query, one computation, two
 * renderings. The brief called this out specifically.
 *
 * Leads with assigned_to = null are grouped under a null userId so the
 * unassigned backlog is visible rather than silently dropped from the totals.
 */
export function buildStaffFunnel(
  leads: Lead[],
  activities: Activity[],
  stages: PipelineStage[],
  members: { id: string; name: string | null; email: string | null; is_active: boolean }[],
): StaffFunnelRow[] {
  const byLead = reachedStagesByLead(leads, activities, stages);

  const contactedStage = resolveMetricStage(stages, "contacted");
  const convertedStage = resolveMetricStage(stages, "converted");
  const contactedKey = contactedStage ? stageKey(contactedStage.name) : null;
  const convertedKey = convertedStage ? stageKey(convertedStage.name) : null;

  const rows = new Map<string | null, StaffFunnelRow>();

  for (const member of members) {
    rows.set(member.id, {
      userId: member.id,
      name: member.name ?? member.email ?? "Unknown",
      isActive: member.is_active,
      assigned: 0,
      contacted: contactedKey ? 0 : null,
      converted: convertedKey ? 0 : null,
    });
  }

  for (const lead of leads) {
    const key = lead.assigned_to;
    if (!rows.has(key)) {
      rows.set(key, {
        userId: key,
        // Reached when a lead is assigned to someone no longer in the members
        // list — a deleted account, or a row RLS hides. Naming it "Unassigned"
        // would be wrong for the second case, so the two are distinguished.
        name: key === null ? "Unassigned" : "Former member",
        isActive: false,
        assigned: 0,
        contacted: contactedKey ? 0 : null,
        converted: convertedKey ? 0 : null,
      });
    }

    const row = rows.get(key)!;
    row.assigned++;

    const reached = byLead.get(lead.id);
    if (!reached) continue;
    if (contactedKey && reached.has(contactedKey) && row.contacted !== null) row.contacted++;
    if (convertedKey && reached.has(convertedKey) && row.converted !== null) row.converted++;
  }

  return [...rows.values()].sort((a, b) => {
    // Unassigned last; otherwise most leads first.
    if (a.userId === null) return 1;
    if (b.userId === null) return -1;
    return b.assigned - a.assigned;
  });
}

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  count: number;
}

/**
 * Leads created per day over the trailing `days` days, inclusive of today.
 *
 * Every day in the window is emitted, including the zeroes. Plotting only the
 * days that have data draws a line that skips the quiet periods, which makes a
 * bad week look like a normal one with fewer points.
 *
 * Bucketed by LOCAL date, matching what the viewer sees on the lead rows
 * elsewhere in the app. Bucketing by UTC would put an evening lead on
 * "tomorrow" for anyone west of Greenwich.
 */
export function buildTrend(leads: Lead[], days = 30): TrendPoint[] {
  const localDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const buckets = new Map<string, number>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.set(localDay(d), 0);
  }

  for (const lead of leads) {
    const created = new Date(lead.created_at);
    if (Number.isNaN(created.getTime())) continue;
    const key = localDay(created);
    // Only counts leads inside the window; older ones fall outside the map.
    if (buckets.has(key)) buckets.set(key, buckets.get(key)! + 1);
  }

  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}
