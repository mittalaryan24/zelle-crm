import Link from "next/link";
import { redirect } from "next/navigation";

import { getProfile } from "@/lib/data/leads";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { MainNav } from "@/components/nav/main-nav";
import { Badge } from "@/components/ui/badge";

/**
 * Shell for every signed-in screen.
 *
 * `(app)` is a ROUTE GROUP — a folder in parentheses. It groups routes so they
 * can share a layout without the folder name appearing in the URL. /leads is
 * still /leads, not /app/leads. That is the only reason this directory exists:
 * the inbox, dashboard, staff and settings screens all want the same header.
 *
 * A Server Component, so getProfile() runs server-side and only rendered HTML
 * reaches the browser.
 *
 * The nav links below are filtered by role, but hiding a link is cosmetic. Each
 * admin page calls requireAdmin() itself — see the note in src/lib/data/admin.ts.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getProfile();

  if (!profile) redirect("/login");

  // organization_id is nullable by design (migration 001): a provisioned user
  // who has not been placed in an org yet. RLS would show them an empty app,
  // which reads as "the product is broken". Say what is actually happening.
  if (!profile.organization_id) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">
            Your account is not in an organization yet
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            An administrator needs to add you to a workspace before you can see any
            leads. Nothing is wrong with your login.
          </p>
          <div className="mt-4">
            <SignOutButton />
          </div>
        </div>
      </main>
    );
  }

  // is_active false means current_org_id() returns NULL, so every RLS policy
  // fails closed and the user sees nothing anywhere. Same reasoning as above:
  // explain it rather than render an inexplicably empty inbox.
  if (!profile.is_active) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">
            This account has been deactivated
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Contact your administrator if you think this is a mistake.
          </p>
          <div className="mt-4">
            <SignOutButton />
          </div>
        </div>
      </main>
    );
  }

  const isAdmin = profile.role === "admin";

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-baseline gap-3">
            <Link
              href={isAdmin ? "/dashboard" : "/leads"}
              className="text-base font-semibold text-slate-900"
            >
              ZELLÉ Lead OS
            </Link>
            <span className="hidden text-sm text-slate-500 sm:inline">
              {profile.organization_name}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium text-slate-900">
                {profile.name ?? profile.email}
              </div>
              <div className="text-xs text-slate-500">{profile.email}</div>
            </div>
            <Badge variant={isAdmin ? "default" : "secondary"}>
              {isAdmin ? "Admin" : "Staff"}
            </Badge>
            <SignOutButton />
          </div>
        </div>

        <MainNav isAdmin={isAdmin} />
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
