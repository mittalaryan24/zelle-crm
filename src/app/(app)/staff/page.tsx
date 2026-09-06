import { getDashboardData, getInvitations, requireAdmin } from "@/lib/data/admin";
import { StaffBreakdown } from "@/components/admin/dashboard-charts";
import {
  ActiveToggle,
  InviteForm,
  RevokeButton,
} from "@/components/admin/staff-controls";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

/**
 * STAFF MANAGEMENT — admin only.
 *
 * The performance columns come from getDashboardData(), the SAME call the
 * dashboard makes, so the staff-breakdown numbers here and there cannot drift.
 * The brief asked for that specifically. `cache()` on getDashboardData means
 * calling it from two places in one request costs one set of round trips.
 */

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default async function StaffPage() {
  const profile = await requireAdmin();
  const [data, invitations] = await Promise.all([getDashboardData(), getInvitations()]);

  const perfByUser = new Map(data.staff.map((row) => [row.userId, row]));
  const activeAdmins = data.members.filter((m) => m.role === "admin" && m.is_active).length;

  const pending = invitations.filter((i) => !i.accepted_at);
  const accepted = invitations.filter((i) => i.accepted_at);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Staff</h1>
        <p className="text-sm text-slate-500">
          {profile.organization_name} · {data.members.length}{" "}
          {data.members.length === 1 ? "member" : "members"}
        </p>
      </div>

      <Panel
        title="Team"
        description="Deactivating someone stops round-robin assigning them new leads, and closes their access immediately. Their existing leads stay with them until reassigned."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Email</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Assigned</th>
                <th className="pb-2 text-right font-medium">Contacted</th>
                <th className="pb-2 text-right font-medium">Converted</th>
                <th className="pb-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.members.map((member) => {
                const perf = perfByUser.get(member.id);
                const isSelf = member.id === profile.id;
                // Mirrors the two refusals in setUserActive(). Disabling the
                // button here is a courtesy; the action refuses regardless.
                const lastAdmin =
                  member.role === "admin" && member.is_active && activeAdmins <= 1;

                return (
                  <tr key={member.id}>
                    <td className="py-2.5 font-medium text-slate-900">
                      {member.name ?? "—"}
                      {isSelf && <span className="ml-1.5 text-xs text-slate-400">you</span>}
                    </td>
                    <td className="py-2.5 text-slate-600">{member.email ?? "—"}</td>
                    <td className="py-2.5">
                      <Badge variant={member.role === "admin" ? "default" : "secondary"}>
                        {member.role === "admin" ? "Admin" : "Staff"}
                      </Badge>
                    </td>
                    <td className="py-2.5">
                      <span
                        className={
                          "inline-flex items-center gap-1.5 text-xs " +
                          (member.is_active ? "text-emerald-700" : "text-slate-400")
                        }
                      >
                        <span
                          className={
                            "h-1.5 w-1.5 rounded-full " +
                            (member.is_active ? "bg-emerald-500" : "bg-slate-300")
                          }
                        />
                        {member.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{perf?.assigned ?? 0}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {perf?.contacted ?? "—"}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {perf?.converted ?? "—"}
                    </td>
                    <td className="py-2.5">
                      <ActiveToggle
                        userId={member.id}
                        isActive={member.is_active}
                        disabled={(isSelf && member.is_active) || lastAdmin}
                        disabledReason={
                          isSelf && member.is_active
                            ? "You cannot deactivate your own account"
                            : "This is the only active administrator"
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Invite a colleague"
        description="Creates an invitation row. The person completes signup themselves — see below for how that works."
      >
        <InviteForm />

        {/*
          Spelled out on screen rather than only in the code, because an admin
          who invites someone and hears nothing will assume it is broken.
        */}
        <details className="mt-4 rounded-md bg-slate-50 p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-700">
            How does an invited person actually get in?
          </summary>
          <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs text-slate-600">
            <li>
              Inviting here writes a row to <code>invitations</code> holding this
              organization and the role you chose. Only an admin can create one, and
              only for their own org — so the pairing is trustworthy.
            </li>
            <li>
              They sign up through Supabase Auth with <strong>that exact email</strong>.
            </li>
            <li>
              A database trigger (<code>handle_new_user</code>) fires on signup, finds
              the pending invitation by email, and copies the organization and role onto
              their profile — then marks the invitation accepted.
            </li>
            <li>
              With no matching invitation their profile is created with no organization,
              and they can see nothing at all. Unassigned means locked out, not
              open access.
            </li>
          </ol>
          <p className="mt-2 text-xs text-amber-700">
            No email is sent yet. Creating the invitation is the authorization half;
            delivering a link needs a mail provider, which is V1.1. For now, tell them
            to sign up with that address.
          </p>
        </details>
      </Panel>

      {pending.length > 0 && (
        <Panel title="Pending invitations" description="Not yet accepted.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Role</th>
                  <th className="pb-2 font-medium">Expires</th>
                  <th className="pb-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pending.map((invite) => {
                  const expired = new Date(invite.expires_at).getTime() < Date.now();
                  return (
                    <tr key={invite.id}>
                      <td className="py-2.5 text-slate-900">{invite.email}</td>
                      <td className="py-2.5 capitalize text-slate-600">{invite.role}</td>
                      <td className="py-2.5 text-slate-600">
                        {formatDateTime(invite.expires_at)}
                        {expired && (
                          <span className="ml-1.5 text-xs text-red-600">expired</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <RevokeButton invitationId={invite.id} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {accepted.length > 0 && (
        <Panel title="Accepted invitations" description="Kept as a record of how people joined.">
          <ul className="space-y-1 text-sm text-slate-600">
            {accepted.map((invite) => (
              <li key={invite.id}>
                {invite.email} · {invite.role} · accepted{" "}
                {formatDateTime(invite.accepted_at)}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title="Performance"
        description="The same breakdown as the dashboard — one query, rendered twice."
      >
        <StaffBreakdown rows={data.staff} />
      </Panel>
    </div>
  );
}
