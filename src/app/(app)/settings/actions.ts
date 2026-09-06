"use server";

import { revalidatePath } from "next/cache";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAdmin } from "@/lib/data/admin";

/**
 * SETTINGS ACTIONS — admin only.
 *
 * A note on why these need an explicit admin check at all: RLS on
 * pipeline_stages and qualification_field_defs grants full CRUD to any
 * authenticated user in the org (migration 003). That is deliberate — the Lead
 * Profile reads both tables for every user, and narrowing SELECT would break it.
 * "Only admins may EDIT the configuration" is a product rule, not a tenancy
 * boundary, so it lives here. checkAdmin() is what makes it real.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Qualification fields
// ---------------------------------------------------------------------------

/**
 * Adding a field.
 *
 * field_key is matched against the CHECK in migration 001:
 * `^[a-z][a-z0-9_]{0,62}$`. Validating here means a typo returns a sentence
 * rather than a raw constraint violation — and the key matters, because it has
 * to equal the top-level key n8n puts in leads.qualification_data. A mismatch
 * shows up as a field that silently never appears on any lead.
 */
export async function addQualificationField(
  fieldKey: string,
  label: string,
): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const key = fieldKey.trim().toLowerCase();
  const trimmedLabel = label.trim();

  if (!/^[a-z][a-z0-9_]{0,62}$/.test(key)) {
    return {
      ok: false,
      error:
        "The field key must start with a letter and contain only lowercase letters, digits and underscores (e.g. budget_month).",
    };
  }
  if (!trimmedLabel) return { ok: false, error: "A label is required." };
  if (trimmedLabel.length > 200) return { ok: false, error: "That label is too long." };

  const supabase = await createSupabaseServerClient();

  // Appended at the end of the current order rather than defaulting to 0, which
  // would silently jump the new field to the top of the Lead Profile.
  const { data: last } = await supabase
    .from("qualification_field_defs")
    .select("order_index")
    .order("order_index", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("qualification_field_defs").insert({
    organization_id: auth.organizationId,
    field_key: key,
    label: trimmedLabel,
    order_index: (last?.order_index ?? -1) + 1,
  });

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `A field with the key "${key}" already exists.` };
    }
    return { ok: false, error: `Could not add the field: ${error.message}` };
  }

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Renaming a label.
 *
 * Only the label. field_key is deliberately immutable through the UI: it is the
 * join to leads.qualification_data, and changing it would orphan the value on
 * every existing lead — the data would still be there but nothing would render
 * it. Delete and re-add is the honest way to make that change, because it makes
 * the consequence visible.
 */
export async function renameQualificationField(
  id: string,
  label: string,
): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const trimmed = label.trim();
  if (!trimmed) return { ok: false, error: "A label is required." };
  if (trimmed.length > 200) return { ok: false, error: "That label is too long." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("qualification_field_defs")
    .update({ label: trimmed })
    .eq("id", id);

  if (error) return { ok: false, error: `Could not rename the field: ${error.message}` };

  revalidatePath("/settings");
  // The Lead Profile reads these labels live, so it picks the change up on its
  // next render. No sync step, and none should be added.
  revalidatePath("/leads", "layout");
  return { ok: true };
}

export async function deleteQualificationField(id: string): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("qualification_field_defs").delete().eq("id", id);

  if (error) return { ok: false, error: `Could not delete the field: ${error.message}` };

  revalidatePath("/settings");
  revalidatePath("/leads", "layout");
  return { ok: true };
}

/**
 * Reorder by swapping order_index with the neighbour.
 *
 * order_index is intentionally NOT unique (migration 001 says why: a drag
 * reorder writes several rows and would trip a non-deferrable unique
 * constraint), so a swap is safe even though it briefly duplicates a value.
 *
 * Two round trips, not a transaction — a crash between them leaves two fields
 * sharing an index, which sorts arbitrarily but breaks nothing. Worth naming
 * rather than pretending it is atomic.
 */
async function swapOrder(
  table: "qualification_field_defs" | "pipeline_stages",
  id: string,
  direction: "up" | "down",
): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const supabase = await createSupabaseServerClient();

  const { data: rows, error: readError } = await supabase
    .from(table)
    .select("id, order_index")
    .order("order_index", { ascending: true });

  if (readError || !rows) {
    return { ok: false, error: `Could not read the current order: ${readError?.message}` };
  }

  const index = rows.findIndex((r) => r.id === id);
  if (index === -1) return { ok: false, error: "That item no longer exists." };

  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= rows.length) return { ok: true }; // already at the end

  const a = rows[index];
  const b = rows[swapWith];

  // Positions in the sorted list, not the stored values — those can contain
  // duplicates or gaps, and swapping duplicates would be a no-op.
  const { error: e1 } = await supabase
    .from(table).update({ order_index: b.order_index }).eq("id", a.id);
  const { error: e2 } = await supabase
    .from(table).update({ order_index: a.order_index }).eq("id", b.id);

  if (e1 || e2) {
    return { ok: false, error: `Could not reorder: ${(e1 ?? e2)?.message}` };
  }

  revalidatePath("/settings");
  revalidatePath("/leads", "layout");
  return { ok: true };
}

export async function moveQualificationField(id: string, direction: "up" | "down") {
  return swapOrder("qualification_field_defs", id, direction);
}

export async function movePipelineStage(id: string, direction: "up" | "down") {
  return swapOrder("pipeline_stages", id, direction);
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

export async function addPipelineStage(name: string): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "A stage name is required." };
  if (trimmed.length > 100) return { ok: false, error: "That stage name is too long." };

  const supabase = await createSupabaseServerClient();

  const { data: last } = await supabase
    .from("pipeline_stages")
    .select("order_index")
    .order("order_index", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("pipeline_stages").insert({
    organization_id: auth.organizationId,
    name: trimmed,
    order_index: (last?.order_index ?? -1) + 1,
  });

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `A stage called "${trimmed}" already exists.` };
    }
    return { ok: false, error: `Could not add the stage: ${error.message}` };
  }

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Renaming a stage.
 *
 * leads.status is free text holding the stage NAME, not a foreign key — a
 * deliberate choice in migration 001 so that renaming a stage cannot orphan
 * leads at the database level. The flip side is that a rename here leaves every
 * existing lead pointing at the OLD name, which would then render as
 * "(not in pipeline)" on the Lead Profile.
 *
 * So the rename carries the leads with it. Both writes are needed for the result
 * to make sense, and again they are not one transaction — the stage is renamed
 * first, so a failure partway leaves leads on the old name, which the profile
 * screen already handles visibly rather than silently.
 */
export async function renamePipelineStage(
  id: string,
  name: string,
): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "A stage name is required." };
  if (trimmed.length > 100) return { ok: false, error: "That stage name is too long." };

  const supabase = await createSupabaseServerClient();

  const { data: stage } = await supabase
    .from("pipeline_stages").select("id, name").eq("id", id).maybeSingle();

  if (!stage) return { ok: false, error: "That stage no longer exists." };
  if (stage.name === trimmed) return { ok: true };

  const { error } = await supabase
    .from("pipeline_stages").update({ name: trimmed }).eq("id", id);

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `A stage called "${trimmed}" already exists.` };
    }
    return { ok: false, error: `Could not rename the stage: ${error.message}` };
  }

  const { error: leadsError } = await supabase
    .from("leads").update({ status: trimmed }).eq("status", stage.name);

  if (leadsError) {
    return {
      ok: false,
      error: `Stage renamed, but the leads still on "${stage.name}" could not be moved: ${leadsError.message}`,
    };
  }

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  revalidatePath("/leads", "layout");
  return { ok: true };
}

/**
 * Deleting a stage, with the orphan check the brief asks for.
 *
 * Because leads.status is free text, the database will happily let a stage be
 * deleted while leads still carry its name. Those leads are not broken exactly —
 * they keep working — but their status no longer corresponds to anything, they
 * vanish from the funnel, and the Lead Profile shows "(not in pipeline)".
 *
 * `reassignTo` is how the caller resolves it. The UI refuses to proceed without
 * it when leads are affected, and shows the count first, so deleting a stage is
 * never a silent data change.
 */
export async function deletePipelineStage(
  id: string,
  reassignTo: string | null,
): Promise<ActionResult> {
  const auth = await checkAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  const supabase = await createSupabaseServerClient();

  const { data: stage } = await supabase
    .from("pipeline_stages").select("id, name").eq("id", id).maybeSingle();

  if (!stage) return { ok: false, error: "That stage no longer exists." };

  const { count: remaining } = await supabase
    .from("pipeline_stages").select("id", { count: "exact", head: true });

  if ((remaining ?? 0) <= 1) {
    return {
      ok: false,
      error: "You cannot delete the last pipeline stage — leads need somewhere to live.",
    };
  }

  const { count: affected } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("status", stage.name);

  const orphanCount = affected ?? 0;

  if (orphanCount > 0) {
    if (!reassignTo) {
      return {
        ok: false,
        error: `${orphanCount} ${orphanCount === 1 ? "lead is" : "leads are"} currently in "${stage.name}". Choose a stage to move them to first.`,
      };
    }

    const { data: target } = await supabase
      .from("pipeline_stages").select("id, name").eq("name", reassignTo).maybeSingle();

    if (!target || target.id === id) {
      return { ok: false, error: "Choose a different, existing stage to move those leads to." };
    }

    const { error: moveError } = await supabase
      .from("leads").update({ status: target.name }).eq("status", stage.name);

    if (moveError) {
      // Nothing has been deleted yet, so the org is left exactly as it was.
      return { ok: false, error: `Could not move those leads: ${moveError.message}` };
    }
  }

  const { error } = await supabase.from("pipeline_stages").delete().eq("id", id);
  if (error) return { ok: false, error: `Could not delete the stage: ${error.message}` };

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  revalidatePath("/leads", "layout");
  return { ok: true };
}
