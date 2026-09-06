# Stage 4 — Manual walkthrough (Dashboard, Staff, Settings)

Companion to the Stage 3 walkthrough. `npm test` already proves the *rules*
(who is refused, what the arithmetic does). This document is for the things a
script cannot judge: whether the numbers on screen are the right numbers, and
whether the screens are usable.

**Before you start**

- [ ] `npm run dev` is running. Note the port it prints — the rest of this
      document says `:3000`, change it if yours differs.
- [ ] The fixture is loaded (`supabase/fixtures/rls_test_fixture.sql`).
- [ ] `npm test` passes. If it does not, fix that first — a failing suite makes
      every observation below ambiguous.

**The cast** (password for all four: `ZelleTest123!`)

| Who   | Email                 | Org                        | Role  |
|-------|-----------------------|----------------------------|-------|
| Priya | admin-a@example.com   | Acme Fitness Studio (A)    | admin |
| Sam   | staff-a@example.com   | Acme Fitness Studio (A)    | staff |
| Diego | admin-b@example.com   | Bright Smile Dental (B)    | admin |
| Nadia | staff-b@example.com   | Bright Smile Dental (B)    | staff |

Org A's leads are Alpha (assigned to Sam) and Gamma (unassigned), plus whatever
your own ingest tests have added. Org B has Beta and Delta.

**Sign out between people.** A stale cookie is the single most common cause of
a confusing result here — you think you are testing Sam's view and you are
still looking at Priya's.

---

## 1. Sam (staff) — the negative case, do this first

Doing this first means you find out the gate works before you spend time on the
screens it guards.

- [ ] Sign in as Sam at `/login`. You land on `/leads`.
- [ ] The left nav shows **Inbox** only. No Dashboard, no Staff, no Settings.
- [ ] Type `/dashboard` into the address bar. You are bounced to `/leads`.
      Not a 403, not an empty dashboard — the inbox.
- [ ] Same for `/staff` and `/settings`.
- [ ] The bounce is instant and you never see a flash of dashboard content.
      (If you do, the guard has moved below a render — that is a real defect.)

## 2. Priya (admin) — Dashboard

Sign out, sign in as Priya, go to `/dashboard`.

**Header and cards**

- [ ] Subtitle names **Acme Fitness Studio**.
- [ ] Five cards: Total leads, Qualified, Assigned, Contacted, Converted.
- [ ] Every card's hint line names the stage it counted, e.g.
      `Reached "Qualified"`. A card reading *No pipeline stage maps to…* is
      correct behaviour, not a bug — it means your org renamed that stage.
- [ ] **Total leads** matches the row count in `/leads`. If it does not, one of
      the two is scoped wrong.

**Bot vs staff — the point of the screen**

- [ ] Two panels side by side: *Bot performance* and *Staff performance*.
- [ ] Qualification rate reads as a percentage, and the line under it says
      `N qualified ÷ M conversations`. Confirm M is the conversation count, not
      the lead count — dividing by leads is the mistake this is guarding.
- [ ] Under Staff performance, **Meetings booked** shows a dash and the note
      "Not tracked yet". It must never show `0`; there is no meeting entity in
      the schema and a zero would be an invented number.

**Funnel, trend, breakdown**

- [ ] Funnel lists *your* stage names (New, Contacted, Qualified, Won, Lost
      unless you renamed them in §4).
- [ ] Funnel counts are *ever reached*, not *currently in*. Sanity check: move a
      lead from Contacted to Won in `/leads`, come back — the Contacted count
      must not drop.
- [ ] Lead trend shows 30 buckets including empty days, oldest on the left.
- [ ] Staff breakdown lists Priya and Sam, plus an **Unassigned** row that sorts
      last. A member with zero leads still appears.
- [ ] Cross-check one number by hand: pick Sam's *Assigned* count here and count
      his rows in `/leads` filtered to him. They must agree.

**Recent leads**

- [ ] Five rows, newest first, rendered with the same table as the inbox.
- [ ] Assignee names are filled in (not blank, not a uuid).
- [ ] "View all" goes to `/leads`.

## 3. Priya — Staff Management (`/staff`)

- [ ] Team table lists Priya (tagged *you*) and Sam.
- [ ] The Assigned / Contacted / Converted columns **match the Staff breakdown
      on the dashboard exactly**. Both read from the same call; a mismatch means
      one of them is being computed twice.

**Deactivation**

- [ ] Your own Deactivate button is disabled. Sam's is not.
- [ ] Deactivate Sam. The row flips to inactive.
- [ ] With Sam inactive, POST a lead through the ingest endpoint
      (`scripts/Test-Ingest.ps1`). It must be assigned to Priya, never to Sam.
- [ ] Sam's *existing* leads are still his — deactivation does not move work.
- [ ] In a private window, sign in as Sam. He authenticates but the inbox is
      empty. (Auth succeeds and RLS refuses — that is the intended shape.)
- [ ] Reactivate Sam. Ingest two more leads; they now share between the two.
- [ ] **Clean up**: delete the probe leads you just ingested, or the dashboard
      numbers you verified in §2 will no longer match.

**Last-admin guard**

- [ ] Priya is the only active admin in Org A, so hers is the "last admin" case.
      Try it from a second admin if you have one; otherwise trust
      `check-admin-writes.mjs`, which covers it.

**Invitations**

- [ ] Invite `newperson@example.com` as staff. It appears under pending.
- [ ] Invite the same address again — refused, with a readable message.
- [ ] The screen explains that **no email is sent** and what the invitee must do
      (sign up with that exact address). If that text is missing, the flow looks
      broken to a real admin.
- [ ] Revoke the invitation. It disappears.

## 4. Priya — Settings (`/settings`)

**Qualification fields**

- [ ] Lists Org A's fields: Fitness goal, Monthly budget, Ready to start.
- [ ] Add a field. Open any lead's profile — the new field is present.
- [ ] Reorder with the up/down controls; the Lead Profile order follows.
- [ ] Rename a field; the label changes on the profile, existing data survives.
- [ ] Delete the field you added.

**Pipeline stages**

- [ ] Lists New, Contacted, Qualified, Won, Lost with a lead count each.
- [ ] Add a stage. It appears in the status dropdown on a lead.
- [ ] **Rename a stage that has leads in it** (e.g. Contacted → Reached out).
      Every lead on the old name moves with it. Check one lead's profile: it
      must show the new name, never "(not in pipeline)".
- [ ] **Delete a stage that has leads in it.** You must be shown the count and
      forced to pick a destination stage before it will proceed. It must not
      delete silently.
- [ ] Delete a stage with zero leads — no destination prompt needed.
- [ ] Try to delete down to the last stage — refused.
- [ ] Duplicate stage name — refused.
- [ ] If any leads were orphaned by earlier testing, the page shows an orphan
      warning with the count. Fix them, then confirm it disappears.
- [ ] **Put the pipeline back** to New/Contacted/Qualified/Won/Lost before you
      finish, or §2's card hints will start reading "No pipeline stage maps to…".

## 5. Diego (admin, Org B) — tenant isolation of the *numbers*

This is the section that matters most. Aggregates are where a leak hides,
because a wrong total does not look like someone else's data.

- [ ] Sign out. Sign in as Diego. Go to `/dashboard`.
- [ ] Subtitle reads **Bright Smile Dental**. The string "Acme Fitness Studio"
      appears nowhere on the page.
- [ ] Total leads is **2** (Beta and Delta), not Org A's total, and not the sum.
- [ ] No Org A lead name (Alpha, Gamma) appears in Recent leads.
- [ ] `/staff` lists only Diego and Nadia — never Priya or Sam.
- [ ] `/settings` shows Org B's vocabulary: Treatment interest, Has insurance,
      Urgency. None of Org A's fields.

## 6. Nadia (staff, Org B)

- [ ] `/dashboard`, `/staff`, `/settings` all bounce her to `/leads`.
      (Same rule as Sam — confirming it is not accidentally per-org.)

## 7. Signed out

- [ ] In a private window, hit `/dashboard`, `/staff`, `/settings` directly.
      Each redirects to `/login`, and none of them renders any content first.

---

## Sign-off

- [ ] Every box above ticked
- [ ] Probe leads, fields, stages and invitations cleaned up
- [ ] `npm test` still passes after the walkthrough

Date: ______________  By: ______________
