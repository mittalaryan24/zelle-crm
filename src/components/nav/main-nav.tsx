"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The primary nav.
 *
 * A Client Component solely because it needs usePathname() to highlight the
 * active tab — that is a browser-side concern. It renders no data of its own.
 *
 * `isAdmin` decides which links appear. This is presentation only: every admin
 * route calls requireAdmin() server-side and redirects a staff user regardless
 * of what is or is not drawn here. Hiding a link stops an honest mistake; it
 * stops nothing else.
 */
const STAFF_LINKS = [{ href: "/leads", label: "Inbox" }];

const ADMIN_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/leads", label: "Inbox" },
  { href: "/staff", label: "Staff" },
  { href: "/settings", label: "Settings" },
];

export function MainNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const links = isAdmin ? ADMIN_LINKS : STAFF_LINKS;

  return (
    <nav className="mx-auto max-w-7xl px-4">
      <ul className="flex gap-1">
        {links.map((link) => {
          // startsWith so /leads/<id> keeps the Inbox tab lit, but guarded with
          // an exact check first so /settings does not also light up for a
          // hypothetical /settings-something route.
          const active =
            pathname === link.href || pathname.startsWith(`${link.href}/`);

          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={
                  "-mb-px inline-block border-b-2 px-3 py-2 text-sm transition-colors " +
                  (active
                    ? "border-slate-900 font-medium text-slate-900"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800")
                }
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
