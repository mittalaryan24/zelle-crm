"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A CLIENT COMPONENT — and one of only two in the auth path.
 *
 * Server Components render once on the server and ship HTML. They cannot use
 * useState, useEffect or event handlers, because there is no browser involved
 * by the time they run. Anything interactive needs "use client" at the top,
 * which tells Next to also send the component's JavaScript to the browser and
 * hydrate it there.
 *
 * A login form is interactive by definition: it holds typed input in state and
 * responds to a submit event. So it is a Client Component, and the page that
 * wraps it (login/page.tsx) stays a Server Component.
 *
 * Signing in from the browser rather than through a Server Action is deliberate.
 * supabase-js sets the session cookies itself, and doing it client-side means
 * the browser's in-memory client is immediately authenticated too — no window
 * where the cookie exists but the client does not know about it.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * Supabase's raw errors are not fit to show a user. "Invalid login
   * credentials" is passable; "AuthApiError: Email not confirmed" and
   * "Failed to fetch" are not. This maps the ones worth distinguishing and
   * gives everything else a plain fallback.
   *
   * Note that a wrong password and an unknown email deliberately produce the
   * SAME message. Telling them apart would turn this form into an account
   * enumeration oracle — an attacker could discover which addresses are
   * registered by watching which error comes back.
   */
  function friendlyError(message: string): string {
    const m = message.toLowerCase();

    if (m.includes("invalid login credentials")) {
      return "That email and password combination is not recognised.";
    }
    if (m.includes("email not confirmed")) {
      return "This account has not been confirmed yet. Check your email for the confirmation link.";
    }
    if (m.includes("too many requests") || m.includes("rate limit")) {
      return "Too many attempts. Wait a minute and try again.";
    }
    if (m.includes("failed to fetch") || m.includes("network")) {
      return "Could not reach the server. Check your connection and try again.";
    }
    return "Could not sign you in. Please try again.";
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setError(friendlyError(signInError.message));
      setPending(false);
      return;
    }

    // `next` is set by middleware when it bounces a deep link, so following a
    // link while logged out lands you where you meant to go. Only relative
    // paths are honoured: an absolute URL here would be an open redirect, where
    // a crafted /login?next=https://evil.example link turns our own domain into
    // a springboard to someone else's.
    const next = searchParams.get("next");
    const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/leads";

    // refresh() re-runs the Server Components with the new session cookie
    // attached. Without it, push() can render the destination from a cache
    // populated while logged out — an empty inbox on a successful login.
    router.replace(destination);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          disabled={pending}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={pending}
        />
      </div>

      {error && (
        // role="alert" so screen readers announce it when it appears, rather
        // than the user tabbing back to find out why nothing happened.
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
