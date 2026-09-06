import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getOrgMembers,
  getPipelineStages,
  getProfile,
  getQualificationFieldDefs,
} from "@/lib/data/leads";
import {
  buildFunnel,
  buildStaffFunnel,
  buildTrend,
  resolveMetricStage,
  reachedStagesByLead,
  type FunnelStep,
  type StaffFunnelRow,
  type TrendPoint,
} from "@/lib/funnel";
import type { Activity, Lead, OrgMember, PipelineStage, Profile } from "@/lib/types";

/**
 * ADMIN-ONLY DATA ACCESS
 * ======================
 * THE PERMISSION MODEL, AND WHY IT IS NOT RLS THIS TIME
 * -----------------------------------------------------
 * Stage 3's staff scoping went into RLS because it was a *data* boundary: which
 * lead rows a staff user may read. Migration 006 made that true in the database,
 * so no application bug could widen it.
 *
 * Stage 4 is a different shape. There is no admin-only *row* here — the
 * dashboard aggregates leads a staff user can already partly see, and
 * pipeline_stages and qualification_field_defs are org-wide config that every
 * user's own screens legitimately read (the Lead Profile renders both). The
 * restriction is on the *screens and the writes*, not on the rows.
 *
 * So this is enforced in two places, and both are server-side:
 *
 *   1. requireAdmin() below, called at the top of every admin page and every
 *      admin Server Action. It reads the role from the session cookie — never
 *      from a parameter, a header, or anything the caller supplies.
 *
 *   2. The database still backstops the tenant boundary. Every query here runs
 *      under the user's own JWT with the anon key, so RLS confines it to their
 *      organization no matter what this file asks for. An admin of Org A cannot
 *      produce Org B's numbers even with a bug in this module.
 *
 * What is deliberately NOT claimed: a determined staff user cannot see these
 * aggregates at all. They could compute some of them from rows RLS already lets
 * them read. The guarantee is that the admin screens and every admin write are
 * refused, and that nothing here widens what the database will hand over.
 */

/**
 * The gate. Redirects rather than rendering for a non-admin.
 *
 * Redirect, not a 403 page, and not `notFound()`: a staff user following a stale
 * link should land somewhere useful. The inbox is where they belong.
 *
 * redirect() works by throwing a special error that Next catches, so nothing
 * after this call runs — which is what makes it safe as a one-line guard at the
 * top of a page. Never wrap it in a try/catch that swallows everything.
 */
export const requireAdmin = cache(async (): Promise<Profile> => {
  const profile = await getProfile();

  if (!profile) redirect("/login");
  if (!profile.organization_id || !profile.is_active) redirect("/leads");
  if (profile.role !== "admin") redirect("/leads");

  return profile;
});

/**
 * Same check, for Server Actions.
 *
 * An action must not redirect — it returns a result to a caller that is often
 * mid-transition — so this reports the refusal instead. Actions are public HTTP
 * endpoints, so this runs even when the UI that calls them was never rendered.
 */
export async function checkAdmin(): Promise<
  { ok: true; profile: Profile; organizationId: string } | { ok: false; error: string }
> {
  const profile = await getProfile();

  if (!profile || !profile.organization_id || !profile.is_active) {
    return { ok: false, error: "Your session has expired. Sign in again." };
  }
  if (profile.role !== "admin") {
    return { ok: false, error: "Only an administrator can do that." };
  }

  return { ok: true, profile, organizationId: profile.organization_id };
}

/**
 * Every lead in the org, unscoped by assignee.
 *
 * Safe to call only from admin paths: for a staff caller RLS would return just
 * their own leads and the dashboard would quietly show a personal funnel
 * labelled as the organization's. requireAdmin() upstream is what prevents that,
 * which is why these are not exported to the leads pages.
 */
const LEAD_METRIC_COLUMNS =
  "id, organization_id, assigned_to, name, phone, channel, source, ai_score, ai_summary, status, qualification_data, source_message_id, created_at, updated_at" as const;

async function getAllOrgLeads(): Promise<Lead[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("leads")
    .select(LEAD_METRIC_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) throw new Error(`Could not load leads: ${error.message}`);
  return (data ?? []) as Lead[];
}

async function getAllOrgActivities(): Promise<Activity[]> {
  const supabase = await createSupabaseServerClient();
  // Only status_change rows matter to the funnel. Filtering server-side keeps a
  // busy org's note and ai_qualified rows off the wire entirely.
  const { data, error } = await supabase
    .from("activities")
    .select("id, lead_id, actor_type, actor_id, type, content, created_at")
    .eq("type", "status_change")
    .limit(20000);

  if (error) throw new Error(`Could not load activities: ${error.message}`);
  return (data ?? []).map((a) => ({ ...a, actor_name: null })) as Activity[];
}

async function getConversationCount(): Promise<number> {
  const supabase = await createSupabaseServerClient();
  // head:true asks PostgREST for the count only — no rows cross the network.
  const { count, error } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true });

  if (error) return 0;
  return count ?? 0;
}

export interface MetricCard {
  label: string;
  /** null means "no stage in this org maps to this metric" — not zero. */
  value: number | null;
  hint: string;
}

export interface DashboardData {
  funnel: FunnelStep[];
  cards: MetricCard[];
  qualificationRate: { rate: number | null; qualified: number; conversations: number };
  trend: TrendPoint[];
  bot: { label: string; value: number | null; note?: string }[];
  human: { label: string; value: number | null; note?: string }[];
  staff: StaffFunnelRow[];
  recentLeads: Lead[];
  members: OrgMember[];
  stages: PipelineStage[];
  totals: { leads: number; assigned: number; conversations: number };
}

/**
 * Everything the dashboard needs, in one place.
 *
 * Four round trips, run in parallel, then all the arithmetic happens in memory
 * via the pure functions in src/lib/funnel.ts. For the scale this is aimed at —
 * a single business's leads — that is far cheaper than a dozen aggregate
 * queries, and it means the funnel definition lives in one testable place
 * rather than being restated in SQL.
 *
 * If an org ever grows past the 5000-lead ceiling above, this becomes a set of
 * SQL aggregates or a materialized view. It is not that today.
 */
export const getDashboardData = cache(async (): Promise<DashboardData> => {
  const [leads, activities, stages, members, conversations] = await Promise.all([
    getAllOrgLeads(),
    getAllOrgActivities(),
    getPipelineStages(),
    getOrgMembers(),
    getConversationCount(),
  ]);

  const funnel = buildFunnel(leads, activities, stages);
  const staff = buildStaffFunnel(leads, activities, stages, members);
  const trend = buildTrend(leads, 30);
  const reached = reachedStagesByLead(leads, activities, stages);

  const countReached = (stage: PipelineStage | null): number | null => {
    if (!stage) return null;
    const key = stage.name.trim().toLowerCase();
    let n = 0;
    for (const set of reached.values()) if (set.has(key)) n++;
    return n;
  };

  const qualifiedStage = resolveMetricStage(stages, "qualified");
  const contactedStage = resolveMetricStage(stages, "contacted");
  const convertedStage = resolveMetricStage(stages, "converted");

  const qualified = countReached(qualifiedStage);
  const contacted = countReached(contactedStage);
  const converted = countReached(convertedStage);
  const assigned = leads.filter((l) => l.assigned_to !== null).length;

  const cards: MetricCard[] = [
    { label: "Total leads", value: leads.length, hint: "All leads in your organization" },
    {
      label: "Qualified",
      value: qualified,
      hint: qualifiedStage
        ? `Reached "${qualifiedStage.name}"`
        : "No pipeline stage maps to Qualified",
    },
    { label: "Assigned", value: assigned, hint: "Leads with an owner" },
    {
      label: "Contacted",
      value: contacted,
      hint: contactedStage
        ? `Reached "${contactedStage.name}"`
        : "No pipeline stage maps to Contacted",
    },
    {
      label: "Converted",
      value: converted,
      hint: convertedStage
        ? `Reached "${convertedStage.name}"`
        : "No pipeline stage maps to Converted",
    },
  ];

  /**
   * Qualification rate = qualified / conversations, NOT qualified / leads.
   *
   * Deliberate, per the Phase 8 reasoning. Every conversation the bot holds is
   * an attempt; only some become leads at all, and fewer still qualify. Dividing
   * by leads would hide the bot's failures — a bot that talks to 100 people,
   * creates 10 leads and qualifies 9 would score 90%, when what it actually did
   * was lose 90 conversations. Dividing by conversations scores it 9%, which is
   * the number worth acting on.
   */
  const qualificationRate =
    conversations > 0 && qualified !== null
      ? Math.round((qualified / conversations) * 1000) / 10
      : null;

  return {
    funnel,
    cards,
    qualificationRate: { rate: qualificationRate, qualified: qualified ?? 0, conversations },
    trend,
    // AI-owned steps: everything up to and including qualification.
    bot: [
      { label: "Conversations held", value: conversations },
      { label: "Leads created", value: leads.length },
      { label: "Qualified by AI", value: qualified },
    ],
    // Human-owned steps: everything after a lead lands with a person.
    human: [
      { label: "Assigned to staff", value: assigned },
      { label: "Contacted", value: contacted },
      {
        label: "Meetings booked",
        value: null,
        // Stated rather than shown as 0. There is no meeting entity, no
        // pipeline stage for it by default, and no activity type that records
        // one — so any number here would be invented.
        note: "Not tracked yet — no meeting event exists in the schema",
      },
      { label: "Converted", value: converted },
    ],
    staff,
    recentLeads: leads.slice(0, 5),
    members,
    stages,
    totals: { leads: leads.length, assigned, conversations },
  };
});

/** Re-exported so Staff Management uses the identical shape. */
export type { StaffFunnelRow, FunnelStep, TrendPoint };

export const getInvitations = cache(async () => {
  const supabase = await createSupabaseServerClient();
  // RLS on invitations is admin-only for the caller's own org (migration 003),
  // so this returns nothing at all for a staff user even if it were reached.
  const { data, error } = await supabase
    .from("invitations")
    .select("id, email, role, expires_at, accepted_at, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return [];
  return data;
});

export { getOrgMembers, getPipelineStages, getQualificationFieldDefs };
