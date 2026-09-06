"use server";

import { revalidatePath } from "next/cache";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAdmin } from "@/lib/data/admin";

/**
 * STAFF MANAGEMENT ACTIONS — every one admin-gated.
 *
 * checkAdmin() reads the role from the session cookie. A Server Action is a
 * public HTTP endpoint: a staff user who never sees the Staff screen can still
 * POST to these, so the check has to happen here rather than in the page that
 * renders the buttons.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Activate or deactivate a colleague.
 *
 * WHY THIS GOES THROUGH THE DATABASE'S OWN RULES
 * `users.is_active` is not one of the columns frozen by the
 * users_guard_tenancy_columns trigger (migration 002) — that trigger blocks id,
 * organization_id and role from client sessions, and deliberately leaves
 * is_active alone.
 *
 * But RLS on users is "update self" only (migration 003), so an admin editing a
 * *colleague* is refused by the database. That is the correct default for a
 * table where the client can reach every column, and it is why this action is
 * the only path: the check that the caller is an admin of the same org happens
 * here, and the write itself goes through the service role.
 *
 * WHAT THIS AFFECTS DOWNSTREAM
 * current_org_id() and is_org_admin() both test `u.is_active`, so deactivating
 * someone makes every RLS policy fail closed for them immediately — they can
 * still sign in, but see nothing. The app renders an explicit "deactivated"
 * state for that (see the (app) layout) rather than an empty inbox.
 *
 * It also feeds round-robin: ingest_lead() only considers active users, so a
 * deactivated member stops receiving new leads on the very next ingestion. Their
 * existing leads stay assigned to them — reassignment is a separate, deliberate
 * act, not a side effect of a toggle.
 */
export async function setUserActive(
  userId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const supabase = await createSupabaseServerClient();

  // Confirm the target is in the caller's org before touching anything. RLS on
  // users is "read own org", so a foreign uuid simply returns nothing here —
  // the tenant check is the database's, not this query's.
  const { data: target } = await supabase
    .from("users")
    .select("id, role, is_active")
    .eq("id", userId)
    .maybeSingle();

  if (!target) {
    return { ok: false, error: "That person is not in your organization." };
  }

  // Locking yourself out is a support ticket, so refuse it. Nothing in the
  // database prevents it — this is a product rule, and it belongs here.
  if (userId === auth.profile.id && !isActive) {
    return {
      ok: false,
      error: "You cannot deactivate your own account. Ask another admin to do it.",
    };
  }

  // An org with no active admin cannot be administered again from inside the
  // app — the remaining path would be the SQL editor. Check before, not after.
  if (target.role === "admin" && !isActive) {
    const { count } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("is_active", true);

    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        error: "This is the only active administrator. Promote someone else first.",
      };
    }
  }

  if (target.is_active === isActive) return { ok: true };

  // The service role bypasses RLS, which is exactly why the org and role checks
  // above are not optional — they are the only thing standing between this call
  // and any user row in the database.
  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  const admin = getSupabaseAdmin();

  const { error } = await admin
    .from("users")
    .update({ is_active: isActive })
    // Belt and braces: re-assert the organization in the WHERE clause, so even
    // a bug in the lookup above cannot write across a tenant boundary.
    .eq("id", userId)
    .eq("organization_id", auth.organizationId);

  if (error) {
    return { ok: false, error: `Could not update that account: ${error.message}` };
  }

  revalidatePath("/staff");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Invite someone to the organization.
 *
 * HOW THE INVITED PERSON ACTUALLY COMPLETES SIGNUP — this is a real flow, not a
 * stub, and it is worth following end to end:
 *
 *   1. This action inserts a row into public.invitations with the org, the role
 *      and the invitee's email. RLS lets an admin insert only for their OWN org
 *      (migration 003), so the org/role pair is trustworthy by construction.
 *
 *   2. The person signs up through Supabase Auth with that same email address —
 *      today via the Supabase dashboard's "Invite user", or any signUp() call.
 *
 *   3. The on_auth_user_created trigger fires (migration 004) and calls
 *      public.handle_new_user(), which looks for a pending, unexpired invitation
 *      matching the new user's email. If it finds one it copies organization_id
 *      and role onto the new public.users row and stamps the invitation
 *      accepted_at / accepted_by.
 *
 *   4. If there is no matching invitation, the profile is still created but with
 *      organization_id NULL — and because every RLS policy compares
 *      `organization_id = current_org_id()`, and NULL = NULL is NULL rather than
 *      true, that user sees nothing at all. Unassigned defaults to locked out.
 *
 * The critical part is step 3 reading the org and role from the invitations
 * table rather than from the signup payload. raw_user_meta_data is written by
 * whoever calls signUp() from the browser, so trusting it would let anyone
 * self-assign {"role": "admin"}.
 *
 * WHAT IS STILL MISSING: no email is sent. Creating the invitation row is the
 * authorization half; delivering a link is the notification half, and that needs
 * an email provider (V1.1). Until then an admin invites here and then sends the
 * person a Supabase invite, or tells them to sign up with that address.
 */
export async function inviteStaff(
  email: string,
  role: "admin" | "staff",
): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const normalized = email.trim().toLowerCase();

  // Matches the CHECK on invitations.email (position('@' in email) > 1) but
  // fails here with a sentence instead of a constraint violation.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, error: "That does not look like an email address." };
  }
  if (role !== "admin" && role !== "staff") {
    return { ok: false, error: "Role must be admin or staff." };
  }

  const supabase = await createSupabaseServerClient();

  // Already a member? The invitation would be accepted by a signup that will
  // never happen, so say so rather than leaving a permanently pending row.
  const { data: existing } = await supabase
    .from("users")
    .select("id")
    .ilike("email", normalized)
    .maybeSingle();

  if (existing) {
    return { ok: false, error: "That person is already in your organization." };
  }

  const { error } = await supabase.from("invitations").insert({
    organization_id: auth.organizationId,
    email: normalized,
    role,
    invited_by: auth.profile.id,
  });

  if (error) {
    // invitations_pending_unique_idx is a PARTIAL unique index — one pending
    // invite per email per org, but a new one is allowed once the first is
    // accepted. 23505 is unique_violation.
    if (error.code === "23505") {
      return {
        ok: false,
        error: "There is already a pending invitation for that address.",
      };
    }
    return { ok: false, error: `Could not create the invitation: ${error.message}` };
  }

  revalidatePath("/staff");
  return { ok: true };
}

/** Withdraw a pending invitation. Accepted ones are history and stay put. */
export async function revokeInvitation(invitationId: string): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from("invitations")
    .delete()
    .eq("id", invitationId)
    // Deleting an accepted invitation would erase the record of how someone
    // came to be in the org.
    .is("accepted_at", null);

  if (error) {
    return { ok: false, error: `Could not revoke the invitation: ${error.message}` };
  }

  revalidatePath("/staff");
  return { ok: true };
}
