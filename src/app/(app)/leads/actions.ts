"use server";

import { revalidatePath } from "next/cache";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getLead, getProfile } from "@/lib/data/leads";
import type { LeadWithAssignee, Profile } from "@/lib/types";

/**
 * SERVER ACTIONS
 * ==============
 * `"use server"` marks every export in this file as a function the browser may
 * *call* but never *see*. Next replaces the import in the client bundle with an
 * RPC stub; the body only ever runs on the server.
 *
 * The critical consequence: an action is a public HTTP endpoint. Anyone can POST
 * to it with any arguments — the arguments are not trustworthy just because your
 * UI passes sensible ones. So every action here re-derives who the caller is
 * from their session cookie and re-checks permission, rather than accepting an
 * actorId or a role from its parameters. Nothing about the caller crosses the
 * network as an argument.
 *
 * `revalidatePath()` at the end of each action busts the Server Component cache
 * for that route, so the page re-renders with the new data on the next paint.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Shared preamble: who is calling, and may they touch this lead?
 *
 * getLead() applies role scoping and RLS, so it returns null for a lead that
 * does not exist, belongs to another org, or belongs to a colleague. All three
 * collapse to the same refusal — see the note on getLead() for why we do not
 * distinguish them.
 */
type LeadAccess =
  | { ok: false; error: string }
  | { ok: true; profile: Profile; lead: LeadWithAssignee; organizationId: string };

async function requireLeadAccess(leadId: string): Promise<LeadAccess> {
  const profile = await getProfile();
  if (!profile?.organization_id || !profile.is_active) {
    return { ok: false, error: "Your session has expired. Sign in again." };
  }

  const lead = await getLead(profile, leadId);
  if (!lead) {
    return { ok: false, error: "That lead is not available." };
  }

  // organizationId is carried separately because Profile.organization_id is
  // `string | null`, and the guard above does not narrow through the returned
  // object. Every caller writes it into a NOT NULL column.
  return { ok: true, profile, lead, organizationId: profile.organization_id };
}

/**
 * Change a lead's pipeline stage and record it.
 *
 * NOT ATOMIC, and worth being honest about: the UPDATE and the activity INSERT
 * are two round trips, so a crash between them would move the lead without
 * logging why. Doing it properly means a PL/pgSQL function like ingest_lead(),
 * which is the right call once these actions settle. For a status change the
 * failure is cosmetic and self-evident on screen, so the simpler version earns
 * its place for now. The order matters though — the activity is written only
 * after the update succeeds, so we never log a change that did not happen.
 */
export async function updateLeadStatus(
  leadId: string,
  newStatus: string,
): Promise<ActionResult> {
  const access = await requireLeadAccess(leadId);
  if (!access.ok) return { ok: false, error: access.error };

  const { profile, lead } = access;
  const supabase = await createSupabaseServerClient();

  // Validate against this org's own stages rather than accepting free text.
  // leads.status is deliberately not a foreign key (see migration 001), so
  // nothing in the database would stop "banana" from being written here.
  const { data: stages } = await supabase
    .from("pipeline_stages")
    .select("name")
    .eq("name", newStatus)
    .limit(1);

  if (!stages || stages.length === 0) {
    return { ok: false, error: "That status is not a stage in your pipeline." };
  }

  if (lead.status === newStatus) return { ok: true };

  const { error: updateError } = await supabase
    .from("leads")
    .update({ status: newStatus })
    .eq("id", leadId);

  if (updateError) {
    return { ok: false, error: `Could not update the status: ${updateError.message}` };
  }

  const { error: activityError } = await supabase.from("activities").insert({
    organization_id: access.organizationId,
    lead_id: leadId,
    actor_type: "user",
    actor_id: profile.id,
    type: "status_change",
    // The shape the brief specifies. describeActivity() also reads the older
    // { from, to } shape written by the Stage 1 fixture and by n8n.
    content: { old_status: lead.status, new_status: newStatus },
  });

  if (activityError) {
    // The status did change, so this is a partial success. Say so precisely
    // rather than reporting a failure the user can see did not happen.
    return {
      ok: false,
      error: `Status updated, but the activity log entry failed: ${activityError.message}`,
    };
  }

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  return { ok: true };
}

export async function addNote(leadId: string, text: string): Promise<ActionResult> {
  const access = await requireLeadAccess(leadId);
  if (!access.ok) return { ok: false, error: access.error };

  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "A note cannot be empty." };
  if (trimmed.length > 5000) {
    return { ok: false, error: "That note is too long (5000 characters maximum)." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("activities").insert({
    organization_id: access.organizationId,
    lead_id: leadId,
    actor_type: "user",
    actor_id: access.profile.id,
    type: "note",
    content: { text: trimmed },
  });

  if (error) return { ok: false, error: `Could not save the note: ${error.message}` };

  revalidatePath(`/leads/${leadId}`);
  return { ok: true };
}

export async function setFollowUp(
  leadId: string,
  followUpDate: string,
  note: string,
): Promise<ActionResult> {
  const access = await requireLeadAccess(leadId);
  if (!access.ok) return { ok: false, error: access.error };

  // <input type="datetime-local"> yields "2026-09-10T14:30" — no timezone. new
  // Date() reads that as local time, which is what the user meant, and
  // toISOString() converts it to UTC for storage. Storing the raw string would
  // make "2pm" mean different moments to different people.
  const parsed = new Date(followUpDate);
  if (!followUpDate || Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "Choose a valid date and time." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("activities").insert({
    organization_id: access.organizationId,
    lead_id: leadId,
    actor_type: "user",
    actor_id: access.profile.id,
    type: "follow_up_set",
    content: {
      follow_up_date: parsed.toISOString(),
      note: note.trim() || null,
    },
  });

  if (error) {
    return { ok: false, error: `Could not set the follow-up: ${error.message}` };
  }

  revalidatePath(`/leads/${leadId}`);
  return { ok: true };
}

/**
 * Admin-only manual override on top of round-robin.
 *
 * Three separate checks, none of which trust the caller:
 *   1. the caller is an admin        — read from their session, not a parameter
 *   2. the lead is theirs to touch   — via getLead()
 *   3. the new assignee is a real, active member of the same org
 *
 * Check 3 is not paranoia. The composite FK leads_assigned_to_fkey would reject
 * a cross-org assignee at the database level, but it would surface as an opaque
 * constraint violation; and it would happily accept a *deactivated* colleague,
 * which is valid SQL and wrong behaviour — the lead would land in the queue of
 * someone who no longer logs in.
 */
export async function reassignLead(
  leadId: string,
  assigneeId: string | null,
): Promise<ActionResult> {
  const access = await requireLeadAccess(leadId);
  if (!access.ok) return { ok: false, error: access.error };

  const { profile, lead } = access;

  if (profile.role !== "admin") {
    return { ok: false, error: "Only an administrator can reassign a lead." };
  }

  const supabase = await createSupabaseServerClient();

  let assigneeName: string | null = null;

  if (assigneeId) {
    // RLS on users is "read own org", so a foreign uuid simply returns nothing
    // here — the tenant check is the database's, not this query's.
    const { data: member } = await supabase
      .from("users")
      .select("id, name, email, is_active")
      .eq("id", assigneeId)
      .maybeSingle();

    if (!member) {
      return { ok: false, error: "That person is not in your organization." };
    }
    if (!member.is_active) {
      return { ok: false, error: "That person's account is deactivated." };
    }
    assigneeName = member.name ?? member.email ?? null;
  }

  if (lead.assigned_to === assigneeId) return { ok: true };

  const { error: updateError } = await supabase
    .from("leads")
    .update({ assigned_to: assigneeId })
    .eq("id", leadId);

  if (updateError) {
    return { ok: false, error: `Could not reassign: ${updateError.message}` };
  }

  const { error: activityError } = await supabase.from("activities").insert({
    organization_id: access.organizationId,
    lead_id: leadId,
    actor_type: "user",
    actor_id: profile.id,
    type: "assignment",
    content: {
      assigned_to: assigneeId,
      assigned_to_name: assigneeName,
      previous_assigned_to: lead.assigned_to,
      // Distinguishes this from the round-robin rows ingest_lead() writes, so
      // the history shows which assignments were automatic and which were not.
      rule: "manual",
      ...(assigneeId ? {} : { result: "unassigned" }),
    },
  });

  if (activityError) {
    return {
      ok: false,
      error: `Reassigned, but the activity log entry failed: ${activityError.message}`,
    };
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  return { ok: true };
}
