import { redirect } from "next/navigation";

import {
  getOrgMembers,
  getPipelineStages,
  getProfile,
  listLeads,
  type LeadFilters as LeadFilterValues,
} from "@/lib/data/leads";
import { LeadFilters } from "@/components/leads/lead-filters";
import { LeadTable } from "@/components/leads/lead-table";

/**
 * LEAD INBOX — a Server Component.
 *
 * Everything below runs on the server: the session lookup, the role decision and
 * the query. The browser receives rendered HTML plus the two small Client
 * Components (filters, table) that need interactivity. It never receives a
 * Supabase query it could edit, and it never receives a lead the user is not
 * entitled to.
 *
 * The brief asks for "one component, not two screens" for the role split, and
 * that is what this is: the same page, with the admin extras (Assigned Staff
 * column, assignee filter, Unassigned toggle, reassign control) switched on by
 * `isAdmin`. The difference between the two roles is which rows the query can
 * return, and that is decided in listLeads(), not here.
 *
 * `searchParams` is a Promise in Next 15 — it must be awaited before use.
 */
export default async function LeadsInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const profile = await getProfile();
  if (!profile?.organization_id) redirect("/login");

  const params = await searchParams;
  const isAdmin = profile.role === "admin";

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // "score" arrives as "80-100", "0-49" or "none". Parsing it here keeps the
  // data layer's contract numeric and keeps the URL vocabulary in one place.
  const scoreParam = single("score");
  let scoreMin: number | undefined;
  let scoreMax: number | undefined;
  if (scoreParam && scoreParam !== "none") {
    const [min, max] = scoreParam.split("-").map(Number);
    if (Number.isFinite(min)) scoreMin = min;
    if (Number.isFinite(max)) scoreMax = max;
  }

  const filters: LeadFilterValues = {
    q: single("q"),
    status: single("status"),
    channel: single("channel"),
    scoreMin,
    scoreMax,
    assignedTo: single("assignee"),
    unassigned: single("unassigned") === "1",
  };

  // Run in parallel — three independent round trips, no reason to queue them.
  const [leads, stages, members] = await Promise.all([
    listLeads(profile, filters),
    getPipelineStages(),
    getOrgMembers(),
  ]);

  // "Not scored" is the absence of a score, which no numeric range expresses.
  // Filtered here rather than in SQL because it is the one case that would need
  // a separate `.is("ai_score", null)` branch in the query builder.
  const visibleLeads =
    scoreParam === "none" ? leads.filter((l) => l.ai_score === null) : leads;

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Lead Inbox</h1>
          <p className="text-sm text-slate-500">
            {isAdmin
              ? "Every lead in your organization, newest first."
              : "Leads assigned to you, newest first."}
          </p>
        </div>
        <span className="whitespace-nowrap text-sm text-slate-500">
          {visibleLeads.length} {visibleLeads.length === 1 ? "lead" : "leads"}
        </span>
      </div>

      <LeadFilters stages={stages} members={members} isAdmin={isAdmin} />
      <LeadTable leads={visibleLeads} members={members} isAdmin={isAdmin} />
    </div>
  );
}
