import type { FunnelStep, StaffFunnelRow, TrendPoint } from "@/lib/funnel";

/**
 * Dashboard visuals — all SERVER Components.
 *
 * No charting library. A funnel is a list of divs with a width, and a 30-point
 * line is an SVG polyline; pulling in Recharts would mean shipping ~90KB of
 * JavaScript and turning these into Client Components to render what the server
 * can emit as finished HTML. If the dashboard later needs tooltips, brushing or
 * zoom, that trade changes — for a read-only V1 it does not.
 */

/** A metric that has no configured stage renders as a dash, never as zero. */
export function MetricValue({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span className="text-slate-400" title="No pipeline stage maps to this metric">
        —
      </span>
    );
  }
  return <span className="tabular-nums">{value.toLocaleString()}</span>;
}

export function Funnel({ steps }: { steps: FunnelStep[] }) {
  if (steps.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        This organization has no pipeline stages configured.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {steps.map((step, index) => {
        // Drop-off against the previous step, which is the number an operator
        // actually reads a funnel for. Only meaningful once there is a previous
        // step with a non-zero count.
        const prev = index > 0 ? steps[index - 1] : null;
        const dropOff =
          prev && prev.reached > 0
            ? Math.round(((prev.reached - step.reached) / prev.reached) * 100)
            : null;

        return (
          <li key={step.stage}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium text-slate-900">{step.stage}</span>
              <span className="flex items-baseline gap-2">
                {dropOff !== null && dropOff > 0 && (
                  <span className="text-xs text-slate-400">−{dropOff}%</span>
                )}
                <span className="tabular-nums font-semibold text-slate-900">
                  {step.reached}
                </span>
              </span>
            </div>
            <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-slate-800"
                style={{ width: `${step.percentOfTop}%` }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Leads created per day, last 30 days.
 *
 * Hand-rolled SVG. viewBox plus preserveAspectRatio="none" lets the chart
 * stretch to its container's width while the path coordinates stay in a fixed
 * 0-300 by 0-100 space, so no measurement or resize listener is needed.
 */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const total = points.reduce((sum, p) => sum + p.count, 0);

  const W = 300;
  const H = 100;
  const step = points.length > 1 ? W / (points.length - 1) : W;

  const coords = points.map((p, i) => ({
    x: i * step,
    // SVG y grows downward, so a high count must map to a LOW y.
    y: H - (p.count / max) * H,
  }));

  const line = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  // Closing the path down to the baseline gives the shaded area under the line.
  const area = `${line} ${W},${H} 0,${H}`;

  if (total === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-500">
        No leads created in the last 30 days.
      </p>
    );
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label={`Leads created per day over the last ${points.length} days. ${total} in total, peaking at ${max} in a day.`}
      >
        <polygon points={area} className="fill-slate-900/10" />
        <polyline
          points={line}
          fill="none"
          className="stroke-slate-800"
          strokeWidth={1.5}
          // Without this the stroke would stretch with the viewBox and look
          // thicker horizontally than vertically.
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      </svg>

      <div className="mt-2 flex justify-between text-xs text-slate-400">
        <span>{points[0]?.date}</span>
        <span>
          {total} {total === 1 ? "lead" : "leads"} · peak {max}/day
        </span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}

/**
 * A bot- or human-owned step list.
 *
 * `note` renders instead of a number for a metric we cannot honestly compute.
 * That is the whole reason the value type is `number | null` rather than
 * `number` — see "Meetings booked" in getDashboardData().
 */
export function StepList({
  steps,
}: {
  steps: { label: string; value: number | null; note?: string }[];
}) {
  const first = steps.find((s) => s.value !== null)?.value ?? 0;

  return (
    <ol className="space-y-2.5">
      {steps.map((step) => {
        const pct =
          step.value !== null && first > 0
            ? Math.round((step.value / first) * 100)
            : null;

        return (
          <li key={step.label} className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-slate-600">{step.label}</span>
            <span className="flex items-baseline gap-2 text-right">
              {step.note ? (
                <span className="text-xs text-amber-600">{step.note}</span>
              ) : (
                pct !== null && <span className="text-xs text-slate-400">{pct}%</span>
              )}
              <span className="text-base font-semibold text-slate-900">
                <MetricValue value={step.value} />
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function StaffBreakdown({
  rows,
  showLinks = true,
}: {
  rows: StaffFunnelRow[];
  showLinks?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No staff to report on yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
            <th className="pb-2 font-medium">Staff</th>
            <th className="pb-2 text-right font-medium">Assigned</th>
            <th className="pb-2 text-right font-medium">Contacted</th>
            <th className="pb-2 text-right font-medium">Converted</th>
            <th className="pb-2 text-right font-medium">Rate</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const rate =
              row.converted !== null && row.assigned > 0
                ? Math.round((row.converted / row.assigned) * 100)
                : null;

            return (
              <tr key={row.userId ?? "unassigned"}>
                <td className="py-2">
                  <span className="text-slate-900">{row.name}</span>
                  {!row.isActive && row.userId && (
                    <span className="ml-1.5 text-xs text-amber-600">inactive</span>
                  )}
                  {showLinks && row.userId && (
                    <a
                      href={`/leads?assignee=${row.userId}`}
                      className="ml-2 text-xs text-slate-400 underline-offset-2 hover:text-slate-700 hover:underline"
                    >
                      view leads
                    </a>
                  )}
                </td>
                <td className="py-2 text-right tabular-nums">{row.assigned}</td>
                <td className="py-2 text-right tabular-nums">
                  <MetricValue value={row.contacted} />
                </td>
                <td className="py-2 text-right tabular-nums">
                  <MetricValue value={row.converted} />
                </td>
                <td className="py-2 text-right tabular-nums text-slate-500">
                  {rate === null ? "—" : `${rate}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
