import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  cached = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        // No user session is involved, so there is nothing to persist or
        // refresh. Leaving these on would have the client try to manage tokens
        // that do not exist.
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );

  return cached;
}
