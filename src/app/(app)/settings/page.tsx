import {
  getPipelineStages,
  getQualificationFieldDefs,
  requireAdmin,
} from "@/lib/data/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PipelineStagesEditor,
  QualificationFieldsEditor,
} from "@/components/admin/settings-controls";

/**
 * SETTINGS — admin only.
 *
 * Two independent sections that happen to share a screen. Neither depends on the
 * other, so they are separate components with separate actions.
 */

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {description && <div className="mt-0.5 text-xs text-slate-500">{description}</div>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * How many leads sit in each stage right now.
 *
 * Note this is CURRENT status, unlike the dashboard funnel which counts stages
 * ever reached. Here the current count is the right one — the question being
 * answered is "if I delete this stage, whose status breaks?", and only leads
 * presently carrying that name are affected.
 */
async function getLeadCountByStage(): Promise<Record<string, number>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("leads").select("status").limit(5000);

  if (error || !data) return {};

  const counts: Record<string, number> = {};
  for (const row of data) {
    if (typeof row.status === "string") {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
  }
  return counts;
}

export default async function SettingsPage() {
  const profile = await requireAdmin();

  const [fields, stages, leadCountByStage] = await Promise.all([
    getQualificationFieldDefs(),
    getPipelineStages(),
    getLeadCountByStage(),
  ]);

  // Leads carrying a status that matches no stage — usually the residue of a
  // stage deleted before this screen existed to warn about it. Surfacing the
  // count makes an invisible problem fixable.
  const stageNames = new Set(stages.map((s) => s.name));
  const orphaned = Object.entries(leadCountByStage).filter(
    ([status]) => !stageNames.has(status),
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500">
          {profile.organization_name} · configuration for this organization only.
        </p>
      </div>

      {orphaned.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">
            Some leads have a status that matches no stage
          </h2>
          <ul className="mt-1.5 space-y-0.5 text-sm text-amber-800">
            {orphaned.map(([status, count]) => (
              <li key={status}>
                <strong>{count}</strong> {count === 1 ? "lead" : "leads"} in &ldquo;
                {status}&rdquo;
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-amber-700">
            These leads still work, but they are missing from the dashboard funnel. Add a
            stage with the matching name, or open each lead and set a current stage.
          </p>
        </div>
      )}

      <Panel
        title="Qualification fields"
        description={
          <>
            What the Lead Profile shows under Qualification, and in what order. The{" "}
            <strong>field key</strong> must match the key the AI sends inside{" "}
            <code>qualification_data</code> — a mismatch means the value is stored but
            never displayed. Changes appear on the Lead Profile immediately; there is no
            separate sync.
          </>
        }
      >
        <QualificationFieldsEditor fields={fields} />
      </Panel>

      <Panel
        title="Pipeline stages"
        description={
          <>
            The stages a lead moves through, and the dashboard funnel&rsquo;s rows.
            Renaming a stage also updates every lead currently in it, so nothing is left
            behind.
          </>
        }
      >
        <PipelineStagesEditor stages={stages} leadCountByStage={leadCountByStage} />
      </Panel>
    </div>
  );
}
