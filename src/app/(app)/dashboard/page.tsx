import Link from "next/link";

import { getDashboardData, requireAdmin } from "@/lib/data/admin";
import {
  Funnel,
  MetricValue,
  StaffBreakdown,
  StepList,
  TrendChart,
} from "@/components/admin/dashboard-charts";
import { LeadTable } from "@/components/leads/lead-table";
import type { LeadWithAssignee } from "@/lib/types";

/**
 * DASHBOARD — admin only.
 *
 * requireAdmin() is the first thing that runs. It redirects a staff user to
 * /leads before a single query is issued, so there is no version of this page
 * where the numbers are computed and then withheld.
 */

function Panel({
  title,
  description,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-5 ${className}`}>
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default async function DashboardPage() {
  const profile = await requireAdmin();
  const data = await getDashboardData();

  // The dashboard's "recent leads" reuses the inbox table rather than growing a
  // second lead row component — the brief asked for this explicitly. It wants
  // assignee names attached, which listLeads() normally does; here the members
  // are already loaded, so the join happens in memory.
  const nameById = new Map(
    data.members.map((m) => [m.id, m.name ?? m.email ?? "Unknown"]),
  );
  const recent: LeadWithAssignee[] = data.recentLeads.map((lead) => ({
    ...lead,
    assignee_name: lead.assigned_to ? (nameById.get(lead.assigned_to) ?? null) : null,
  }));

  const rate = data.qualificationRate;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500">
          {profile.organization_name} · all figures cover this organization only.
        </p>
      </div>

      {/* ---- Metric cards ---- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {data.cards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-slate-200 bg-white p-4"
          >
            <div className="text-xs text-slate-500">{card.label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">
              <MetricValue value={card.value} />
            </div>
            <div className="mt-1 text-xs text-slate-400">{card.hint}</div>
          </div>
        ))}
      </div>

      {/*
        ---- Bot vs staff ----
        First and widest, because it is the section the brief calls the whole
        point of the screen: it separates "the AI is not producing qualified
        leads" from "the team is not working the leads it is given". Those have
        completely different fixes, and a single blended funnel hides which one
        you are looking at.
      */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Bot performance"
          description="Steps the AI owns, from first conversation to a qualified lead."
        >
          <StepList steps={data.bot} />

          <div className="mt-4 rounded-md bg-slate-50 p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-600">Qualification rate</span>
              <span className="text-lg font-semibold text-slate-900">
                {rate.rate === null ? "—" : `${rate.rate}%`}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {rate.qualified} qualified ÷ {rate.conversations} conversations. Measured
              against conversations, not leads — dividing by leads would hide the
              conversations that never became one.
            </p>
          </div>
        </Panel>

        <Panel
          title="Staff performance"
          description="Steps a person owns, from assignment onward."
        >
          <StepList steps={data.human} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Funnel"
          description="Leads that reached each stage, not leads currently sitting in it."
        >
          <Funnel steps={data.funnel} />
        </Panel>

        <Panel title="Lead trend" description="Leads created per day, last 30 days.">
          <TrendChart points={data.trend} />
        </Panel>
      </div>

      <Panel
        title="Staff breakdown"
        description="The same funnel, grouped by who the lead is assigned to."
      >
        <StaffBreakdown rows={data.staff} />
      </Panel>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Recent leads</h2>
          <Link
            href="/leads"
            className="text-xs text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
          >
            View all
          </Link>
        </div>
        <LeadTable leads={recent} members={data.members} isAdmin />
      </section>
    </div>
  );
}
