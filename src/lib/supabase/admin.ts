import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { ConfigurationError, requireEnv, requireUrlEnv } from "@/lib/env";

/**
 * Supabase client authenticated with the SERVICE ROLE key.
 *
 * ⚠️ This client bypasses Row Level Security completely. It can read and write
 * every organization's data with no policy checks at all — it is a master key
 * to the database.
 *
 * Using it here is deliberate and correct. The ingestion endpoint is called by
 * n8n, a machine. There is no logged-in user, so there is no session for RLS to
 * derive an organization from, and RLS would simply block everything. All
 * authorization on this path comes from the API key check instead: the key
 * identifies exactly one organization, and ingest_lead() derives the
 * organization_id from the key's hash rather than from anything in the request.
 *
 * The consequence is that this file has no safety net. On a normal user-facing
 * route a forgotten `.eq('organization_id', ...)` is caught by RLS; here it
 * would leak. That is why the multi-tenant logic lives inside ingest_lead()
 * rather than being assembled from client calls in TypeScript.
 *
 * RULES
 *   - `import "server-only"` above makes the build fail if this module is ever
 *     pulled into a Client Component. That is a guard rail, not a formality.
 *   - The env var has no NEXT_PUBLIC_ prefix, so Next will not inline it into
 *     the browser bundle. Never rename it to one.
 *   - Never pass this client, or anything derived from it, to the client side.
 */

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = requireUrlEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  // A Supabase key is a JWT: three base64url segments separated by dots. This
  // catches the mistakes that otherwise fail confusingly far from their cause —
  // pasting the project URL, the project ref, or a database password here.
  if (serviceRoleKey.split(".").length !== 3) {
    throw new ConfigurationError(
      "SUPABASE_SERVICE_ROLE_KEY does not look like a Supabase key (expected a " +
        "JWT with three dot-separated segments). Copy the `service_role` value " +
        "from Supabase Dashboard → Settings → API — not the project URL, the " +
        "project ref, or your database password.",
    );
  }

  // The anon and service_role keys are both long JWTs and look nearly identical
  // at a glance, so pasting the wrong one is easy — and the symptom is baffling:
  // every query silently returns zero rows, because the anon key is subject to
  // RLS and this endpoint has no user session for RLS to derive an org from.
  // The role sits in the JWT payload, which is base64url and readable without
  // verifying the signature. This is a developer-experience check, not a
  // security one — the real verification happens at Supabase.
  try {
    const payload = JSON.parse(
      Buffer.from(serviceRoleKey.split(".")[1], "base64url").toString("utf8"),
    ) as { role?: string };

    if (payload.role && payload.role !== "service_role") {
      throw new ConfigurationError(
        `SUPABASE_SERVICE_ROLE_KEY holds a key whose role is "${payload.role}", ` +
          `not "service_role". The anon key cannot be used here: it is subject to ` +
          `Row Level Security, and this endpoint has no user session, so every ` +
          `query would return nothing. Copy the \`service_role\` key instead.`,
      );
    }
  } catch (error) {
    // Re-throw our own error. Ignore decode/parse failures: Supabase has issued
    // more than one key format, and a key we cannot decode is not necessarily
    // wrong — the request itself will surface the real problem.
    if (error instanceof ConfigurationError) throw error;
  }

  cached = createClient(url, serviceRoleKey, {
    auth: {
      // No user session is involved, so there is nothing to persist or refresh.
      // Leaving these on would have the client try to manage tokens that do not
      // exist.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return cached;
}
