import { Suspense } from "react";

import { LoginForm } from "@/components/auth/login-form";

/**
 * A SERVER COMPONENT. It renders no interactive state of its own — it just
 * draws the card and hands off to <LoginForm />, which is the client half.
 *
 * Keeping the split at this boundary means the page shell, the heading and the
 * layout ship as plain HTML, and only the form's logic becomes JavaScript in
 * the browser. That is the general pattern in this app: Server Components by
 * default, "use client" only where interaction actually starts.
 *
 * There is no sign-up link, by design. Users are provisioned through the
 * invitations table (migration 001), not self-registration — a public signup
 * form would let anyone create an account with organization_id NULL and is a
 * door with nothing behind it.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            ZELLÉ Lead OS
          </h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to your workspace</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {/*
            useSearchParams() (inside LoginForm, for the `next` param) requires a
            Suspense boundary. Without one, Next cannot statically prerender this
            page and the build fails with a "missing suspense boundary" error.
          */}
          <Suspense fallback={<div className="h-64" />}>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Accounts are created by invitation. Contact your administrator for access.
        </p>
      </div>
    </main>
  );
}
