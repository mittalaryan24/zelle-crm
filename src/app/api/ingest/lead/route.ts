import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { extractBearerToken, hashApiKey } from "@/lib/api-key";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { formatValidationErrors, ingestLeadSchema } from "./schema";

/**
 * POST /api/ingest/lead
 *
 * Called server-to-server by n8n once the AI bot has qualified a lead.
 * Authentication is an organization-scoped API key in an Authorization header;
 * there is no user session involved.
 *
 * Responses
 *   201  created    — a new lead, conversation and activity rows were written
 *   200  duplicate  — this source_message_id was already ingested; nothing written
 *   400  invalid_json | invalid_payload
 *   401  missing_api_key | invalid_api_key
 *   405  method_not_allowed
 *   500  internal_error
 *
 * Every response carries `error.code` (or `status` on success) so the n8n
 * workflow can branch on the category of failure without parsing prose, plus a
 * `request_id` that also appears in the server logs for correlation.
 */

// The Node runtime, not Edge: node:crypto and the Supabase admin client both
// expect it. Ingestion is never cached or statically rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ErrorCode =
  | "missing_api_key"
  | "invalid_api_key"
  | "invalid_json"
  | "invalid_payload"
  | "method_not_allowed"
  | "internal_error";

function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: string[],
) {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) }, request_id: requestId },
    { status, headers: { "X-Request-Id": requestId } },
  );
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    // ---- Step 1: authenticate ------------------------------------------------
    // Deliberately before body parsing. A caller with a bad key learns only that
    // their key is bad — never whether their payload would have been accepted.
    const rawKey = extractBearerToken(request.headers.get("authorization"));

    if (!rawKey) {
      return errorResponse(
        401,
        "missing_api_key",
        "Missing or malformed Authorization header. Expected: Authorization: Bearer <api-key>",
        requestId,
      );
    }

    const supabase = getSupabaseAdmin();
    const keyHash = hashApiKey(rawKey);

    // Looked up by hash, so the raw key is never compared, logged or stored.
    // `.is("revoked_at", null)` is the SQL `IS NULL` test — a revoked key stops
    // working immediately without being deleted, preserving the audit trail.
    const { data: apiKey, error: apiKeyError } = await supabase
      .from("api_keys")
      .select("id, organization_id")
      .eq("key_hash", keyHash)
      .is("revoked_at", null)
      .maybeSingle();

    if (apiKeyError) {
      // A database failure while checking the key is a server problem, not an
      // authentication failure. Reporting it as 401 would send n8n chasing a
      // credential that is actually fine.
      console.error("[ingest/lead] api key lookup failed", {
        requestId,
        error: apiKeyError.message,
      });
      return errorResponse(
        500,
        "internal_error",
        "Could not verify the API key. Retry shortly.",
        requestId,
      );
    }

    if (!apiKey) {
      // Never echo the key back, not even truncated.
      console.warn("[ingest/lead] rejected unknown or revoked api key", { requestId });
      return errorResponse(
        401,
        "invalid_api_key",
        "The provided API key is not valid, or has been revoked.",
        requestId,
      );
    }

    // ---- Step 2: validate the body ------------------------------------------
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(
        400,
        "invalid_json",
        "Request body could not be parsed as JSON. Check the Content-Type header and the payload.",
        requestId,
      );
    }

    if (
      body !== null &&
      typeof body === "object" &&
      "organization_id" in body
    ) {
      // Ignored rather than honoured — but surfaced, because a workflow sending
      // it is misconfigured and the author should find that out.
      console.warn(
        "[ingest/lead] payload contained organization_id; ignoring. " +
          "The organization is derived from the API key.",
        { requestId, organizationId: apiKey.organization_id },
      );
    }

    const parsed = ingestLeadSchema.safeParse(body);

    if (!parsed.success) {
      const details = formatValidationErrors(parsed.error);
      console.warn("[ingest/lead] payload rejected", { requestId, details });
      return errorResponse(
        400,
        "invalid_payload",
        "Request body failed validation.",
        requestId,
        details,
      );
    }

    // ---- Steps 3-6: one atomic call -----------------------------------------
    // Idempotency check, lead, conversation, round-robin assignment and the
    // activity rows all happen inside ingest_lead(). One statement, one
    // transaction: it either all lands or none of it does. Doing this as four
    // separate supabase.from().insert() calls would be four separate
    // transactions, and a failure partway would leave a lead with no
    // conversation and no way to roll back.
    //
    // Note that the key HASH is passed, not the organization_id we just looked
    // up. The function re-derives the organization itself, so there is no
    // parameter through which a caller — or a bug in this file — could target
    // the wrong tenant.
    const { data, error } = await supabase.rpc("ingest_lead", {
      p_key_hash: keyHash,
      p_payload: parsed.data,
    });

    if (error) {
      console.error("[ingest/lead] ingest_lead failed", {
        requestId,
        organizationId: apiKey.organization_id,
        sourceMessageId: parsed.data.source_message_id,
        code: error.code,
        message: error.message,
        details: error.details,
      });
      return errorResponse(
        500,
        "internal_error",
        "The lead could not be saved. No partial data was written; the request can be retried safely.",
        requestId,
      );
    }

    const result = data as {
      status: "unauthorized" | "duplicate" | "created";
      lead_id?: string;
      conversation_id?: string;
      assigned_to?: string | null;
      lead_status?: string;
    };

    // Only reachable if the key was revoked in the moments between the lookup
    // above and this call. Rare, but it is a real 401 rather than a 500.
    if (result.status === "unauthorized") {
      return errorResponse(
        401,
        "invalid_api_key",
        "The provided API key is not valid, or has been revoked.",
        requestId,
      );
    }

    // ---- Step 3 outcome: already ingested ------------------------------------
    // 200, not 201 — nothing was created. n8n can safely treat this as success:
    // it means the lead is already in the system, which is what a retry wants.
    if (result.status === "duplicate") {
      return NextResponse.json(
        {
          status: "duplicate",
          duplicate: true,
          lead_id: result.lead_id,
          message: "A lead with this source_message_id already exists for this organization.",
          request_id: requestId,
        },
        { status: 200, headers: { "X-Request-Id": requestId } },
      );
    }

    // ---- Step 7: created -----------------------------------------------------
    if (result.assigned_to === null) {
      // Not an error — the lead is saved and findable in the Unassigned queue —
      // but it means the org has no active users, which someone should fix.
      console.warn("[ingest/lead] lead created but unassigned: no active users", {
        requestId,
        organizationId: apiKey.organization_id,
        leadId: result.lead_id,
      });
    }

    return NextResponse.json(
      {
        status: "created",
        duplicate: false,
        lead_id: result.lead_id,
        conversation_id: result.conversation_id,
        assigned_to: result.assigned_to,
        lead_status: result.lead_status,
        request_id: requestId,
      },
      { status: 201, headers: { "X-Request-Id": requestId } },
    );
  } catch (caught) {
    // Anything unforeseen. The message is logged but never returned — internal
    // errors can carry connection strings, table names and other detail that
    // does not belong in a response.
    console.error("[ingest/lead] unhandled error", {
      requestId,
      error: caught instanceof Error ? caught.message : String(caught),
      stack: caught instanceof Error ? caught.stack : undefined,
    });
    return errorResponse(
      500,
      "internal_error",
      "An unexpected error occurred. The request can be retried safely.",
      requestId,
    );
  }
}

/**
 * Without these, Next answers any other verb with a bare 405 and an empty body,
 * which is confusing to debug from n8n. This returns the same error envelope as
 * every other failure.
 */
async function methodNotAllowed() {
  const requestId = randomUUID();
  return errorResponse(
    405,
    "method_not_allowed",
    "This endpoint only accepts POST.",
    requestId,
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
