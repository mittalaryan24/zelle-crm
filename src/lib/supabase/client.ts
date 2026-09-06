"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for Client Components (the browser).
 *
 * Only the login form and the sign-out button use this. Every read of lead data
 * happens on the server instead — see src/lib/data/leads.ts for why.
 *
 * Both values here are NEXT_PUBLIC_*, meaning Next inlines them into the
 * JavaScript bundle and anyone can read them from devtools. That is fine and
 * intended: the anon key is a public identifier, not a secret. It grants nothing
 * on its own — every request it makes is filtered by RLS against the signed-in
 * user's session. The service role key must never appear in a file like this.
 *
 * These are read directly from process.env rather than through requireEnv():
 * that helper is server-only, and Next's build-time inlining needs to see the
 * literal `process.env.NEXT_PUBLIC_...` text to substitute it.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
