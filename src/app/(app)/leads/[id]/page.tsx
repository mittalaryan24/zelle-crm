import Link from "next/link";
import { redirect } from "next/navigation";

import {
  getActivities,
  getConversation,
  getLead,
  getPipelineStages,
  getProfile,
  getQualificationFieldDefs,
} from "@/lib/data/leads";
import {
  FollowUpControl,
  NoteControl,
  StatusControl,
} from "@/components/leads/lead-actions";
import { LeadTranscript } from "@/components/leads/lead-transcript";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  CHANNEL_CLASSES,
  CHANNEL_LABELS,
  SCORE_BAND_CLASSES,
  describeActivity,
  describeActor,
  formatDateTime,
  formatRelative,
  scoreBand,
  telNumber,
  whatsappNumber,
} from "@/lib/format";

/**
 * LEAD PROFILE — a Server Component.
 *
 * The access decision happens on line ~60, before anything is rendered:
 * getLead() applies role scoping and runs under RLS, so a staff user asking for
 * a colleague's lead id gets null and falls straight through to the not-found
 * state. There is no version of this page where the data is fetched and then
 * hidden — the query comes back empty, which is what the brief asks for.
 */

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default async function LeadProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await getProfile();
  if (!profile?.organization_id) redirect("/login");

  const { id } = await params;
  const lead = await getLead(profile, id);

  // One state for "no such lead", "another organization's lead" and "a
  // colleague's lead". Distinguishing them would confirm that a guessed id is
  // real, which is a small information leak with no upside for the user.
  if (!lead) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border border-slate-200 bg-white p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Lead not available</h1>
        <p className="mt-2 text-sm text-slate-600">
          {profile.role === "admin"
            ? "This lead does not exist, or it belongs to another organization."
            : "This lead does not exist, or it is not assigned to you. Ask an administrator if you need access."}
        </p>
        <Link
          href="/leads"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}
        >
          Back to inbox
        </Link>
      </div>
    );
  }

  const [messages, activities, stages, fieldDefs] = await Promise.all([
    getConversation(lead.id),
    getActivities(lead.id),
    getPipelineStages(),
    getQualificationFieldDefs(),
  ]);

  const tel = telNumber(lead.phone);
  const wa = whatsappNumber(lead.phone);

  /**
   * Qualification data, rendered generically.
   *
   * Order and labels come from this org's qualification_field_defs rows, which
   * is what lets a gym and a dental practice share this screen. Keys present in
   * the jsonb but absent from the defs are appended at the end rather than
   * dropped — the AI sending a field nobody has defined yet is a configuration
   * gap, and hiding the data would make it invisible instead of fixable.
   */
  const definedKeys = new Set(fieldDefs.map((d) => d.field_key));
  const qualificationRows = [
    ...fieldDefs
      .filter((def) => def.field_key in lead.qualification_data)
      .map((def) => ({
        key: def.field_key,
        label: def.label,
        value: lead.qualification_data[def.field_key],
        undefined_field: false,
      })),
    ...Object.entries(lead.qualification_data)
      .filter(([key]) => !definedKeys.has(key))
      .map(([key, value]) => ({
        key,
        label: key,
        value,
        undefined_field: true,
      })),
  ];

  const band = scoreBand(lead.ai_score);

  return (
    <div className="space-y-4">
      <Link
        href="/leads"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2")}
      >
        ← Back to inbox
      </Link>

      {/* ---- 1. HEADER ---- */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-900">
                {lead.name ?? "Unnamed lead"}
              </h1>
              <Badge variant="outline" className={CHANNEL_CLASSES[lead.channel] ?? ""}>
                {CHANNEL_LABELS[lead.channel] ?? lead.channel}
              </Badge>
              <Badge variant="secondary">{lead.status}</Badge>
            </div>

            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              {lead.ai_summary ?? "No AI summary was captured for this lead."}
            </p>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              {lead.phone && <span>{lead.phone}</span>}
              {lead.source && <span>Source: {lead.source}</span>}
              <span>Created {formatDateTime(lead.created_at)}</span>
              <span>
                {lead.assignee_name
                  ? `Assigned to ${lead.assignee_name}`
                  : "Unassigned"}
              </span>
            </div>
          </div>

          <div className="text-center">
            <div
              className={
                "flex h-16 w-16 items-center justify-center rounded-xl border text-2xl font-bold tabular-nums " +
                SCORE_BAND_CLASSES[band]
              }
            >
              {lead.ai_score ?? "—"}
            </div>
            <div className="mt-1 text-xs text-slate-500">AI score</div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* ---- 2. CONTACT ACTIONS ---- */}
          <Section
            title="Contact"
            description="Instagram has no reliable deep link to a DM thread — read the transcript below and reply in the app."
          >
            {tel || wa ? (
              <div className="flex flex-wrap gap-2">
                {tel && (
                  <a
                    href={`tel:${tel}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Call {lead.phone}
                  </a>
                )}
                {/*
                  noopener/noreferrer on every target="_blank": without it the
                  opened page gets a handle on this one via window.opener and
                  can navigate it somewhere else.
                */}
                {wa && (
                  <a
                    href={`https://wa.me/${wa}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    WhatsApp
                  </a>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                No usable phone number on this lead, so there is nothing to dial.
              </p>
            )}
          </Section>

          {/* ---- 3. QUALIFICATION DATA ---- */}
          <Section
            title="Qualification"
            description="Labels come from your organization's field definitions."
          >
            {qualificationRows.length === 0 ? (
              <p className="text-sm text-slate-500">
                The AI did not capture any qualification fields for this lead.
              </p>
            ) : (
              <dl className="divide-y divide-slate-100">
                {qualificationRows.map((row) => (
                  <div key={row.key} className="grid grid-cols-3 gap-4 py-2">
                    <dt className="text-sm text-slate-500">
                      {row.label}
                      {row.undefined_field && (
                        <span
                          className="ml-1 text-xs text-amber-600"
                          title="This key is not defined in your organization's qualification fields"
                        >
                          (undefined field)
                        </span>
                      )}
                    </dt>
                    <dd className="col-span-2 text-sm text-slate-900">
                      {/*
                        qualification_data is jsonb: the value can be a string,
                        a number, a boolean, null, or a nested object. String()
                        on an object yields "[object Object]", so anything
                        non-primitive is JSON-stringified instead.
                      */}
                      {row.value === null || row.value === undefined
                        ? "—"
                        : typeof row.value === "object"
                          ? JSON.stringify(row.value)
                          : String(row.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Section>

          {/* ---- 4. CONVERSATION ---- */}
          <Section title="Conversation" description="The AI's chat with this lead.">
            <LeadTranscript messages={messages} />
          </Section>

          {/* ---- 7. ACTIVITY HISTORY ---- */}
          <Section title="Activity" description="Newest first.">
            {activities.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing has happened yet.</p>
            ) : (
              <ol className="space-y-3">
                {activities.map((activity) => (
                  <li key={activity.id} className="flex gap-3">
                    <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300" />
                    <div className="min-w-0">
                      <p className="text-sm text-slate-900">
                        {describeActivity(activity)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {describeActor(activity)} ·{" "}
                        <span title={formatDateTime(activity.created_at)}>
                          {formatRelative(activity.created_at)}
                        </span>
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>

        {/* ---- 5, 6, 8: the write controls ---- */}
        <div className="space-y-4">
          <Section title="Status">
            <StatusControl
              leadId={lead.id}
              currentStatus={lead.status}
              stages={stages}
            />
          </Section>

          <Section title="Notes">
            <NoteControl leadId={lead.id} />
          </Section>

          <Section title="Follow-up">
            <FollowUpControl leadId={lead.id} />
          </Section>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Details</h2>
            <Separator className="my-3" />
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Channel</dt>
                <dd className="text-slate-900">
                  {CHANNEL_LABELS[lead.channel] ?? lead.channel}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Source</dt>
                <dd className="text-slate-900">{lead.source ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Assigned to</dt>
                <dd className="text-slate-900">{lead.assignee_name ?? "Unassigned"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Last updated</dt>
                <dd className="text-slate-900">{formatRelative(lead.updated_at)}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
