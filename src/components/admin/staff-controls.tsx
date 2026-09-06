"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { inviteStaff, revokeInvitation, setUserActive } from "@/app/(app)/staff/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Interactive controls for Staff Management.
 *
 * Every one of these calls a Server Action and then router.refresh(), which
 * re-runs the page's Server Components so the table repaints from the database
 * rather than from optimistic local state.
 */

export function ActiveToggle({
  userId,
  isActive,
  disabled,
  disabledReason,
}: {
  userId: string;
  isActive: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await setUserActive(userId, !isActive);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="text-right">
      <Button
        type="button"
        size="sm"
        variant={isActive ? "outline" : "default"}
        onClick={toggle}
        disabled={isPending || disabled}
        title={disabled ? disabledReason : undefined}
      >
        {isPending ? "Saving…" : isActive ? "Deactivate" : "Activate"}
      </Button>
      {error && (
        <p role="alert" className="mt-1 max-w-52 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function InviteForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "staff">("staff");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSent(null);

    startTransition(async () => {
      const result = await inviteStaff(email, role);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSent(email.trim().toLowerCase());
      setEmail("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div>
          <Label htmlFor="invite-email" className="text-xs text-slate-500">
            Email address
          </Label>
          <Input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="new.colleague@company.com"
            className="mt-1.5 h-9"
            disabled={isPending}
          />
        </div>

        <div>
          <Label htmlFor="invite-role" className="text-xs text-slate-500">
            Role
          </Label>
          <select
            id="invite-role"
            className="mt-1.5 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "staff")}
            disabled={isPending}
          >
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <Button type="submit" size="sm" className="h-9" disabled={isPending || !email.trim()}>
          {isPending ? "Creating…" : "Invite"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {sent && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Invitation created for <strong>{sent}</strong>. No email has been sent — that
          needs a mail provider and is not built yet. Ask them to sign up with this exact
          address and the signup trigger will place them in this organization
          automatically.
        </p>
      )}
    </form>
  );
}

export function RevokeButton({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="text-right">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await revokeInvitation(invitationId);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.refresh();
          });
        }}
      >
        {isPending ? "Revoking…" : "Revoke"}
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
