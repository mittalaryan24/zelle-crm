"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OrgMember, PipelineStage } from "@/lib/types";

/**
 * Filter state lives in the URL, not in React state.
 *
 * Two reasons that is worth the extra plumbing. A filtered inbox becomes a
 * shareable, bookmarkable link ("here are the unassigned Instagram leads"), and
 * the filtering itself stays server-side — the page is a Server Component that
 * reads searchParams and queries with them, so the browser never receives rows
 * it then hides. A client-side `.filter()` over a full lead list would ship
 * every lead to every user and call it a filter.
 */

const SCORE_RANGES = [
  { value: "", label: "Any score" },
  { value: "80-100", label: "High (80+)" },
  { value: "50-79", label: "Medium (50–79)" },
  { value: "0-49", label: "Low (below 50)" },
  { value: "none", label: "Not scored" },
];

const CHANNELS = [
  { value: "", label: "All channels" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "whatsapp", label: "WhatsApp" },
];

export function LeadFilters({
  stages,
  members,
  isAdmin,
}: {
  stages: PipelineStage[];
  members: OrgMember[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Held locally so typing feels instant, then debounced into the URL below.
  const [search, setSearch] = useState(searchParams.get("q") ?? "");

  function buildUrl(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  function apply(updates: Record<string, string | null>) {
    startTransition(() => router.push(buildUrl(updates)));
  }

  // Debounce the search box: without this, every keystroke is a server round
  // trip and a re-render, and the results flicker behind your typing.
  useEffect(() => {
    const current = searchParams.get("q") ?? "";
    if (search === current) return;

    const timer = setTimeout(() => {
      startTransition(() => router.push(buildUrl({ q: search || null })));
    }, 300);

    return () => clearTimeout(timer);
    // buildUrl closes over searchParams/pathname, both of which are in the deps
    // that matter here; adding it would re-run the effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, searchParams, pathname, router]);

  const activeScore = searchParams.get("score") ?? "";
  const activeStatus = searchParams.get("status") ?? "";
  const activeChannel = searchParams.get("channel") ?? "";
  const activeAssignee = searchParams.get("assignee") ?? "";
  const showingUnassigned = searchParams.get("unassigned") === "1";

  const hasFilters =
    Boolean(search) ||
    Boolean(activeScore || activeStatus || activeChannel || activeAssignee) ||
    showingUnassigned;

  const selectClass =
    "h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm " +
    "shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400";

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 lg:col-span-2">
          <Label htmlFor="lead-search" className="text-xs text-slate-500">
            Search
          </Label>
          <Input
            id="lead-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or phone number"
            className="h-9"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="filter-status" className="text-xs text-slate-500">
            Status
          </Label>
          <select
            id="filter-status"
            className={selectClass}
            value={activeStatus}
            onChange={(e) => apply({ status: e.target.value || null })}
          >
            <option value="">All statuses</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.name}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="filter-channel" className="text-xs text-slate-500">
            Channel
          </Label>
          <select
            id="filter-channel"
            className={selectClass}
            value={activeChannel}
            onChange={(e) => apply({ channel: e.target.value || null })}
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="filter-score" className="text-xs text-slate-500">
            AI score
          </Label>
          <select
            id="filter-score"
            className={selectClass}
            value={activeScore}
            onChange={(e) => apply({ score: e.target.value || null })}
          >
            {SCORE_RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/*
          Admin-only controls. Hiding them is presentation, not protection —
          listLeads() ignores both parameters for a staff caller, and RLS would
          return nothing regardless.
        */}
        {isAdmin && (
          <div className="space-y-1.5">
            <Label htmlFor="filter-assignee" className="text-xs text-slate-500">
              Assigned staff
            </Label>
            <select
              id="filter-assignee"
              className={selectClass}
              value={showingUnassigned ? "" : activeAssignee}
              disabled={showingUnassigned}
              onChange={(e) => apply({ assignee: e.target.value || null })}
            >
              <option value="">Anyone</option>
              {members
                .filter((m) => m.is_active)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? m.email}
                  </option>
                ))}
            </select>
          </div>
        )}

        {isAdmin && (
          <div className="flex items-end">
            <Button
              type="button"
              variant={showingUnassigned ? "default" : "outline"}
              size="sm"
              className="h-9 w-full"
              onClick={() =>
                apply({
                  unassigned: showingUnassigned ? null : "1",
                  // Mutually exclusive with a specific assignee — a lead cannot
                  // be both unassigned and assigned to Sam.
                  assignee: null,
                })
              }
            >
              {showingUnassigned ? "✓ Unassigned only" : "Unassigned only"}
            </Button>
          </div>
        )}
      </div>

      {hasFilters && (
        <div className="mt-3 flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              startTransition(() => router.push(pathname));
            }}
          >
            Clear all filters
          </Button>
          {isPending && <span className="text-xs text-slate-400">Updating…</span>}
        </div>
      )}
    </div>
  );
}
