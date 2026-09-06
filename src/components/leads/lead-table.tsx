"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { reassignLead } from "@/app/(app)/leads/actions";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CHANNEL_CLASSES,
  CHANNEL_LABELS,
  SCORE_BAND_CLASSES,
  formatRelative,
  scoreBand,
} from "@/lib/format";
import type { LeadWithAssignee, OrgMember } from "@/lib/types";

/**
 * The inbox table.
 *
 * A Client Component, because rows are clickable and the admin reassign control
 * is interactive. It receives already-filtered, already-scoped rows as props —
 * it does no filtering of its own, and it could not widen what it was given
 * even if it tried.
 */
export function LeadTable({
  leads,
  members,
  isAdmin,
}: {
  leads: LeadWithAssignee[];
  members: OrgMember[];
  isAdmin: boolean;
}) {
  const router = useRouter();

  if (leads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center">
        <p className="text-sm font-medium text-slate-900">No leads to show</p>
        <p className="mt-1 text-sm text-slate-500">
          Try clearing the filters, or wait for the next lead to come in.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[16%]">Name</TableHead>
            <TableHead className="w-[9%]">Channel</TableHead>
            <TableHead className="w-[8%]">AI score</TableHead>
            <TableHead>AI summary</TableHead>
            <TableHead className="w-[10%]">Status</TableHead>
            {isAdmin && <TableHead className="w-[14%]">Assigned staff</TableHead>}
            <TableHead className="w-[10%]">Created</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {leads.map((lead) => (
            <TableRow
              key={lead.id}
              onClick={() => router.push(`/leads/${lead.id}`)}
              className="cursor-pointer"
              // Rows are not natively focusable or activatable by keyboard.
              // Without these three attributes the whole inbox is unusable
              // without a mouse.
              tabIndex={0}
              role="link"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(`/leads/${lead.id}`);
                }
              }}
            >
              <TableCell className="font-medium text-slate-900">
                {lead.name ?? "Unnamed lead"}
                {lead.phone && (
                  <div className="text-xs font-normal text-slate-500">{lead.phone}</div>
                )}
              </TableCell>

              <TableCell>
                <Badge
                  variant="outline"
                  className={CHANNEL_CLASSES[lead.channel] ?? ""}
                >
                  {CHANNEL_LABELS[lead.channel] ?? lead.channel}
                </Badge>
              </TableCell>

              <TableCell>
                <span
                  className={
                    "inline-flex h-7 min-w-9 items-center justify-center rounded-md border px-2 " +
                    "text-sm font-semibold tabular-nums " +
                    SCORE_BAND_CLASSES[scoreBand(lead.ai_score)]
                  }
                >
                  {lead.ai_score ?? "—"}
                </span>
              </TableCell>

              <TableCell className="text-slate-600">
                {/*
                  Truncated to one line per the brief. `max-w-0` with a table
                  cell is the trick that makes truncate actually work — without
                  it the cell grows to fit the text instead of clipping it.
                */}
                <div className="max-w-0 truncate" title={lead.ai_summary ?? undefined}>
                  {lead.ai_summary ?? "—"}
                </div>
              </TableCell>

              <TableCell>
                <Badge variant="secondary">{lead.status}</Badge>
              </TableCell>

              {isAdmin && (
                <TableCell>
                  <AssigneeCell lead={lead} members={members} />
                </TableCell>
              )}

              <TableCell
                className="whitespace-nowrap text-sm text-slate-500"
                title={new Date(lead.created_at).toLocaleString()}
              >
                {formatRelative(lead.created_at)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Admin reassignment, inline in the row.
 *
 * stopPropagation on the wrapper matters: without it, opening the dropdown
 * bubbles up to the row's onClick and navigates away from the inbox before you
 * can pick anyone.
 */
function AssigneeCell({
  lead,
  members,
}: {
  lead: LeadWithAssignee;
  members: OrgMember[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(value: string) {
    setError(null);
    const assigneeId = value === "" ? null : value;

    startTransition(async () => {
      const result = await reassignLead(lead.id, assigneeId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <select
        aria-label={`Reassign ${lead.name ?? "lead"}`}
        className="h-8 w-full rounded-md border border-slate-200 bg-white px-1.5 text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
        value={lead.assigned_to ?? ""}
        disabled={isPending}
        onChange={(e) => handleChange(e.target.value)}
      >
        <option value="">Unassigned</option>
        {members
          // A deactivated user who still holds leads stays listed, so the row
          // does not silently misreport who owns it — but only while they are
          // the current assignee. They cannot be picked for a new assignment.
          .filter((m) => m.is_active || m.id === lead.assigned_to)
          .map((m) => (
            <option key={m.id} value={m.id} disabled={!m.is_active}>
              {m.name ?? m.email}
              {m.is_active ? "" : " (inactive)"}
            </option>
          ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
