import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizeMessages } from "@/lib/format";
import type {
  Activity,
  Lead,
  LeadWithAssignee,
  OrgMember,
  PipelineStage,
  Profile,
  QualificationFieldDef,
  TranscriptMessage,
} from "@/lib/types";

/**
 * SERVER-ONLY DATA ACCESS
 * =======================
 * Every function here runs on the server. `import "server-only"` makes the build
 * fail if any of it is ever pulled into a Client Component — a guard rail worth
 * having, because the difference is invisible at a glance and the consequence is
 * shipping a query the user can rewrite.
 *
 * There are two independent layers of protection on lead data, and the design
 * intent is that either one alone would be sufficient:
 *
 *   1. RLS (migration 006). A staff user's JWT cannot read a lead assigned to
 *      someone else, full stop — not through this app, not through devtools,
 *      not through a raw PostgREST call. This is the real guarantee.
 *
 *   2. Explicit query scoping below. `applyRoleScope()` adds
 *      `.eq("assigned_to", profile.id)` for staff anyway.
 *
 * Belt and braces is deliberate. Layer 2 keeps the intent legible in the code
 * and keeps the app correct if someone later relaxes a policy; layer 1 keeps it
 * correct if someone later forgets to call applyRoleScope(). Neither is load
 * bearing on its own.
 */

/**
 * `cache()` memoizes for the lifetime of a single request.
 *
 * The profile is needed by the layout (to draw the header), by the page (to
 * decide admin vs staff) and by the data functions (to scope queries). Without
 * this, one page render would make the same round trip three or four times.
 * This is per-request, not a cross-user cache — nothing leaks between sessions.
 */
export const getProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createSupabaseServerClient();

  // getUser() revalidates the JWT with the auth server rather than trusting the
  // cookie. See the note in middleware.ts.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from("users")
    .select("id, organization_id, name, email, role, is_active, organizations(name)")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data) return null;

  // PostgREST types an embedded to-one relation as an array in some versions.
  const org = data.organizations as unknown as { name: string } | { name: string }[] | null;
  const organizationName = Array.isArray(org) ? (org[0]?.name ?? null) : (org?.name ?? null);

  return {
    id: data.id,
    organization_id: data.organization_id,
    name: data.name,
    email: data.email,
    role: data.role,
    is_active: data.is_active,
    organization_name: organizationName,
  };
});

/**
 * Written as one literal rather than a concatenation on purpose. supabase-js
 * parses the select string *at the type level* to infer the row shape, and it
 * can only do that for a literal — a concatenated expression degrades to
 * `GenericStringError` and every field access downstream fails to compile.
 */
const LEAD_COLUMNS =
  "id, organization_id, assigned_to, name, phone, channel, source, ai_score, ai_summary, status, qualification_data, source_message_id, created_at, updated_at" as const;

export interface LeadFilters {
  q?: string;
  status?: string;
  channel?: string;
  scoreMin?: number;
  scoreMax?: number;
  assignedTo?: string;
  unassigned?: boolean;
}

/**
 * PostgREST's `.or()` takes a comma-separated filter string, so a search term
 * containing a comma, parenthesis or quote would change the meaning of the
 * expression rather than being matched literally. Stripping those characters is
 * enough here: they are punctuation nobody searches a name or phone number for.
 *
 * `%` and `_` are the LIKE wildcards. Left in on purpose — a user typing "%"
 * gets a wildcard, which is a mildly useful accident and cannot escape the
 * filter.
 */
function sanitizeSearch(term: string): string {
  return term.replace(/[,()"'\\]/g, " ").trim();
}

/**
 * The single place where role decides what a query can return.
 *
 * Admin: every lead in the org (RLS already limits it to their org).
 * Staff: only leads assigned to them.
 */
function applyRoleScope<T extends { eq: (col: string, val: string) => T }>(
  query: T,
  profile: Profile,
): T {
  if (profile.role === "admin") return query;
  return query.eq("assigned_to", profile.id);
}

export async function listLeads(
  profile: Profile,
  filters: LeadFilters = {},
): Promise<LeadWithAssignee[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from("leads")
    .select(LEAD_COLUMNS)
    // Default sort: newest first, per the brief.
    .order("created_at", { ascending: false })
    .limit(200);

  query = applyRoleScope(query, profile);

  if (filters.q) {
    const term = sanitizeSearch(filters.q);
    if (term) {
      query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%`);
    }
  }

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.channel) query = query.eq("channel", filters.channel);

  if (typeof filters.scoreMin === "number") {
    query = query.gte("ai_score", filters.scoreMin);
  }
  if (typeof filters.scoreMax === "number") {
    query = query.lte("ai_score", filters.scoreMax);
  }

  // Admin-only filters. Guarded by role rather than by trusting the query
  // string: a staff user appending ?unassigned=1 must not widen their scope.
  // (RLS would return nothing anyway — a staff user matches no unassigned lead,
  // since `NULL = <uuid>` is never true. This makes the intent explicit.)
  if (profile.role === "admin") {
    if (filters.unassigned) {
      query = query.is("assigned_to", null);
    } else if (filters.assignedTo) {
      query = query.eq("assigned_to", filters.assignedTo);
    }
  }

  const { data, error } = await query;
  if (error) throw new Error(`Could not load leads: ${error.message}`);

  const members = await getOrgMembers();
  const nameById = new Map(members.map((m) => [m.id, m.name ?? m.email ?? "Unknown"]));

  return (data ?? []).map((lead) => ({
    ...(lead as Lead),
    assignee_name: lead.assigned_to ? (nameById.get(lead.assigned_to) ?? null) : null,
  }));
}

/**
 * One lead, or null.
 *
 * Null is returned for "does not exist", "belongs to another organization" and
 * "belongs to a colleague" alike — the caller renders the same not-found state
 * for all three. That is deliberate: distinguishing them would confirm to a
 * staff user that a given lead id is real and simply off-limits, which is an
 * information leak in itself.
 */
export async function getLead(
  profile: Profile,
  leadId: string,
): Promise<LeadWithAssignee | null> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from("leads")
    .select(LEAD_COLUMNS)
    .eq("id", leadId);

  query = applyRoleScope(query, profile);

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;

  const members = await getOrgMembers();
  const assigneeName = data.assigned_to
    ? (members.find((m) => m.id === data.assigned_to)?.name ?? null)
    : null;

  return { ...(data as Lead), assignee_name: assigneeName };
}

export async function getConversation(leadId: string): Promise<TranscriptMessage[]> {
  const supabase = await createSupabaseServerClient();

  // No role scoping needed: migration 006's conversations policy already reduces
  // to "you can read this iff you can read its lead". A staff user querying a
  // colleague's lead_id gets nothing back from the database itself.
  const { data, error } = await supabase
    .from("conversations")
    .select("messages")
    .eq("lead_id", leadId)
    .maybeSingle();

  if (error || !data) return [];
  return normalizeMessages(data.messages);
}

export async function getActivities(leadId: string): Promise<Activity[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("activities")
    .select("id, lead_id, actor_type, actor_id, type, content, created_at")
    // Reverse chronological, per the brief.
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error || !data) return [];

  const members = await getOrgMembers();
  const nameById = new Map(members.map((m) => [m.id, m.name ?? m.email ?? "Unknown"]));

  return data.map((a) => ({
    ...(a as Omit<Activity, "actor_name">),
    actor_name: a.actor_id ? (nameById.get(a.actor_id) ?? null) : null,
  }));
}

/**
 * Everyone in the caller's organization.
 *
 * RLS on users is "read own org", so this cannot return an outsider. Used for
 * the assignee-name lookups above and for the admin reassignment dropdown.
 */
export const getOrgMembers = cache(async (): Promise<OrgMember[]> => {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("users")
    .select("id, name, email, role, is_active")
    .order("name", { ascending: true });

  if (error || !data) return [];
  return data as OrgMember[];
});

export const getPipelineStages = cache(async (): Promise<PipelineStage[]> => {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("pipeline_stages")
    .select("id, name, order_index")
    .order("order_index", { ascending: true });

  if (error || !data) return [];
  return data as PipelineStage[];
});

/**
 * The org's field definitions, as a field_key -> label map plus display order.
 *
 * This is what makes the qualification panel work for a dental practice and a
 * gym without a code change: the labels come from the tenant's own rows, not
 * from a hardcoded list in a component.
 */
export const getQualificationFieldDefs = cache(
  async (): Promise<QualificationFieldDef[]> => {
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase
      .from("qualification_field_defs")
      .select("id, field_key, label, order_index")
      .order("order_index", { ascending: true });

    if (error || !data) return [];
    return data as QualificationFieldDef[];
  },
);
