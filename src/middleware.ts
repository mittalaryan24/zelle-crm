import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Runs before every matched request. Two jobs.
 *
 * 1. REFRESH THE SESSION. Supabase access tokens are short-lived and are
 *    renewed using a refresh token in a cookie. Server Components cannot write
 *    cookies, so if the refresh happened during a render the new token would be
 *    computed and then thrown away — the user would be logged out roughly every
 *    hour for no visible reason. Middleware can write cookies, so the refresh
 *    happens here, before any render.
 *
 * 2. GATE THE ROUTES. An unauthenticated request to an app page is redirected to
 *    /login, and an authenticated request to /login is redirected to the inbox.
 *
 * Point 2 is convenience, NOT security. Middleware is a redirect, and a redirect
 * is advice the client can decline. The actual protection is RLS: even if
 * someone reached a page without a session, every query would return zero rows.
 * Treat this file as routing polish over a database-level guarantee.
 */
export async function middleware(request: NextRequest) {
  // Must start as a pass-through of the incoming request so that cookies we set
  // below travel on both the request (for this render) and the response (for
  // the browser). Constructing a fresh NextResponse here instead is the classic
  // way to end up with a session that works once and then vanishes.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser(), not getSession(). getSession() reads the cookie and trusts it;
  // getUser() revalidates the token against the Supabase auth server. On the
  // server the cookie is attacker-supplied input, so the difference matters.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isLoginPage = pathname === "/login";

  if (!user && !isLoginPage) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    // Preserved so that following a deep link while logged out lands you where
    // you were going after signing in, rather than dumping you on the inbox.
    redirectUrl.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && isLoginPage) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/leads";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   _next/static, _next/image  — build output, no session needed
     *   favicon.ico, image files   — static assets
     *   api/                       — the ingestion route authenticates with an
     *                                API key, not a cookie. Running this
     *                                middleware over it would redirect n8n's
     *                                POST to /login and break Stage 2.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
