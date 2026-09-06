import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { requireEnv, requireUrlEnv } from "@/lib/env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * THE IMPORTANT PART: this uses the ANON key, not the service role key.
 *
 * `src/lib/supabase/admin.ts` exists for the ingestion route, where there is no
 * logged-in human and RLS has no session to derive a tenant from. Everything in
 * the user-facing app is the opposite case: there IS a session, so the anon key
 * plus the user's JWT is exactly right, and RLS does the tenant isolation. Using
 * the admin client here would silently disable every policy in migrations 003
 * and 006 and turn a UI bug into a cross-tenant data leak.
 *
 * The anon key carries no privileges of its own. Authorization comes entirely
 * from the user's access token, which @supabase/ssr reads out of the request
 * cookies below and attaches to every PostgREST call.
 *
 * WHY THIS IS A FUNCTION AND NOT A MODULE-LEVEL SINGLETON
 * `cookies()` is request-scoped. A module-level client would capture the first
 * request's cookies and then serve every subsequent user from that same session
 * — one user seeing another's data. Create one per request, always.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    requireUrlEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components are not allowed to write cookies — only Server
            // Actions and Route Handlers are. Supabase calls setAll here when it
            // refreshes an expiring token, which can happen during a render.
            //
            // Swallowing this is safe *because* middleware.ts refreshes the
            // session on every request before the render begins, so the cookie
            // is already current by the time we get here. Without that
            // middleware this catch would hide real session expiry.
          }
        },
      },
    },
  );
}
