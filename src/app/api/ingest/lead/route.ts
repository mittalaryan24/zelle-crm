import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { extractBearerToken, hashApiKey } from "@/lib/api-key";
import { ConfigurationError } from "@/lib/env";
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
  | "configuration_error"
  | "internal_error";

/**
 * Internal detail is echoed to the caller outside production only.
 *
 * In development, a 500 that says "an unexpected error occurred" and nothing
 * else is close to useless — you are left correlating request ids against a
 * terminal. In production the same detail is a liability: driver errors carry
 * table names, column names and occasionally connection strings.
 *
 * `configuration_error` is exempt and always returned in full. "You did not
 * fill in .env.local" contains no secrets and is the single most useful thing
 * a developer can be told.
 */
const EXPOSE_INTERNAL_ERRORS = process.env.NODE_ENV !== "production";

function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  requestId: string,
  options: { details?: string[]; debug?: string } = {},
) {
  const { details, debug } = options;

  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        ...(debug && EXPOSE_INTERNAL_ERRORS ? { debug } : {}),
      },
      request_id: requestId,
    },
    { status, headers: { "X-Request-Id": requestId, "X-Ingest-Route": "lead" } },
  );
}

/**
 * One-line headline before any structured detail.
 *
 * Node prints a multi-line object for the detail, and a stack trace runs to
 * dozens of lines. Without a headline the actual cause scrolls off the top of
 * the terminal and the failure reads as "no output at all" — which is exactly
 * how this route's first real failure was reported.
 */
function logFailure(requestId: string, summary: string, detail?: unknown) {
  console.error(`\n[ingest/lead] ✖ ${requestId} — ${summary}`);
  if (detail !== undefined) console.error(detail);
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
      logFailure(requestId, `api_keys lookup failed: ${apiKeyError.message}`, {
        code: apiKeyError.code,
        details: apiKeyError.details,
        hint: apiKeyError.hint,
      });
      return errorResponse(
        500,
        "internal_error",
        "Could not verify the API key against the database.",
        requestId,
        {
          debug:
            `${apiKeyError.message}` +
            (apiKeyError.hint ? ` — hint: ${apiKeyError.hint}` : "") +
            (apiKeyError.code === "42P01"
              ? " — the api_keys table does not exist. Has migration " +
                "20260905090400_api_keys_and_ingest.sql been applied?"
              : ""),
        },
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
      console.warn(`[ingest/lead] ⚠ ${requestId} — payload rejected`, details);
      return errorResponse(
        400,
        "invalid_payload",
        "Request body failed validation.",
        requestId,
        { details },
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
      // PGRST202 means PostgREST could not find the function with this exact
      // name and parameter set — a signature mismatch between this call and
      // migration 005, or a schema cache that has not picked the function up
      // yet. Worth naming explicitly: the raw message is cryptic.
      const signatureProblem = error.code === "PGRST202";

      logFailure(
        requestId,
        `ingest_lead() rpc failed [${error.code ?? "no code"}]: ${error.message}`,
        {
          organizationId: apiKey.organization_id,
          sourceMessageId: parsed.data.source_message_id,
          details: error.details,
          hint: error.hint,
        },
      );

      return errorResponse(
        500,
        "internal_error",
        "The lead could not be saved. No partial data was written; the request can be retried safely.",
        requestId,
        {
          debug:
            `[${error.code ?? "no code"}] ${error.message}` +
            (error.details ? ` — ${error.details}` : "") +
            (error.hint ? ` — hint: ${error.hint}` : "") +
            (signatureProblem
              ? " — PostgREST cannot find public.ingest_lead(p_key_hash text, " +
                "p_payload jsonb). Check migration 20260905090400 ran, that " +
                "EXECUTE is granted to service_role, and reload the schema " +
                "cache (Dashboard → API Docs → Reload, or NOTIFY pgrst, 'reload schema')."
              : ""),
        },
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
        { status: 200, headers: { "X-Request-Id": requestId, "X-Ingest-Route": "lead" } },
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
      { status: 201, headers: { "X-Request-Id": requestId, "X-Ingest-Route": "lead" } },
    );
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : String(caught);

    // Misconfiguration is reported in full, in every environment. It names an
    // environment variable and what to do about it — no secrets, and the
    // alternative is watching someone debug an unedited .env.local for an hour.
    if (caught instanceof ConfigurationError) {
      logFailure(requestId, `CONFIGURATION ERROR — ${message}`);
      return errorResponse(500, "configuration_error", message, requestId);
    }

    // supabase-js throws this from createClient() when the URL will not parse.
    // In practice that means .env.local was copied from .env.example and never
    // edited, so say so rather than leaving a cryptic library message.
    if (/Invalid supabaseUrl/i.test(message)) {
      const explained =
        `${message} — NEXT_PUBLIC_SUPABASE_URL is not a usable URL. If .env.local ` +
        `was copied from .env.example, replace the placeholders with the real ` +
        `values from Supabase Dashboard → Settings → API, then restart the dev server.`;
      logFailure(requestId, `CONFIGURATION ERROR — ${explained}`);
      return errorResponse(500, "configuration_error", explained, requestId);
    }

    // A network-level failure reaching Supabase. Usually a wrong project ref,
    // or no connectivity — not something a retry of the same request will fix.
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(message)) {
      logFailure(requestId, `cannot reach Supabase: ${message}`, caught);
      return errorResponse(
        500,
        "internal_error",
        "Could not reach the Supabase project.",
        requestId,
        {
          debug:
            `${message} — check NEXT_PUBLIC_SUPABASE_URL points at a project ` +
            `that exists and that this machine has network access.`,
        },
      );
    }

    logFailure(requestId, `unhandled ${caught instanceof Error ? caught.name : "error"}: ${message}`, caught);

    return errorResponse(
      500,
      "internal_error",
      "An unexpected error occurred. The request can be retried safely.",
      requestId,
      { debug: message },
    );
  }
}

/**
 * Without these, Next answers any other verb with a bare 405 and an empty body,
 * which is confusing to debug from n8n. This returns the same error envelope as
 * every other failure.
 *
 * It also logs. A silent 405 looks identical from the client to a 500 from some
 * other process on the port you meant to use, and "nothing in the dev server
 * terminal" is the signal that tells you the request never arrived here at all.
 * Every response this file produces should leave a trace on both sides.
 */
function methodNotAllowed(request: NextRequest) {
  const requestId = randomUUID();
  logFailure(
    requestId,
    `${request.method} is not allowed on this endpoint; only POST is`,
  );
  return errorResponse(
    405,
    "method_not_allowed",
    `This endpoint only accepts POST. Received ${request.method}.`,
    requestId,
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

/**
 * HEAD and OPTIONS are deliberately NOT methodNotAllowed.
 *
 * They are the two verbs a probe uses, and answering them is what makes "is the
 * ingest route actually on this port?" a question you can answer in one command.
 * Both carry X-Request-Id and X-Ingest-Route, so a caller can tell a response
 * from this route apart from a response from whatever else is listening — which
 * is precisely the confusion that a dev-server port auto-switch creates.
 */
export async function HEAD() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "X-Request-Id": randomUUID(),
      "X-Ingest-Route": "lead",
      Allow: "POST, HEAD, OPTIONS",
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "X-Request-Id": randomUUID(),
      "X-Ingest-Route": "lead",
      Allow: "POST, HEAD, OPTIONS",
    },
  });
}
