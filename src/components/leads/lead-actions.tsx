"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addNote, setFollowUp, updateLeadStatus } from "@/app/(app)/leads/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PipelineStage } from "@/lib/types";

/**
 * The three write controls on the profile: status, note, follow-up.
 *
 * Each calls a Server Action and then router.refresh(), which re-runs the page's
 * Server Components and repaints the activity history with the new row. No
 * client-side state duplication of the server's data — the server stays the one
 * source of truth and the UI just asks it again.
 *
 * Both roles get all three. The brief is explicit that admin-only restrictions
 * apply to reassignment and org-wide visibility, not to working a lead you can
 * already see.
 */

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-2 text-sm text-red-600">
      {message}
    </p>
  );
}

export function StatusControl({
  leadId,
  currentStatus,
  stages,
}: {
  leadId: string;
  currentStatus: string;
  stages: PipelineStage[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: string) {
    setError(null);
    startTransition(async () => {
      const result = await updateLeadStatus(leadId, next);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  // A lead's status is free text and only *expected* to match a stage (see
  // migration 001). If it has drifted — a stage was renamed after the lead was
  // set to it — the current value would not appear in the list and the select
  // would silently show the wrong thing. Add it explicitly instead.
  const statusIsKnown = stages.some((s) => s.name === currentStatus);

  return (
    <div>
      <Label htmlFor="lead-status" className="text-xs text-slate-500">
        Pipeline stage
      </Label>
      <select
        id="lead-status"
        className="mt-1.5 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
        value={currentStatus}
        disabled={isPending}
        onChange={(e) => handleChange(e.target.value)}
      >
        {!statusIsKnown && (
          <option value={currentStatus}>{currentStatus} (not in pipeline)</option>
        )}
        {stages.map((stage) => (
          <option key={stage.id} value={stage.name}>
            {stage.name}
          </option>
        ))}
      </select>
      {isPending && <p className="mt-2 text-xs text-slate-400">Saving…</p>}
      <ErrorLine message={error} />
    </div>
  );
}

export function NoteControl({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const result = await addNote(leadId, text);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Cleared only after the write succeeds. Clearing optimistically would
      // discard what the user typed if the save failed.
      setText("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <Label htmlFor="lead-note" className="text-xs text-slate-500">
        Add a note
      </Label>
      <Textarea
        id="lead-note"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What happened on this lead?"
        rows={3}
        className="mt-1.5"
        disabled={isPending}
      />
      <div className="mt-2 flex justify-end">
        <Button type="submit" size="sm" disabled={isPending || !text.trim()}>
          {isPending ? "Saving…" : "Add note"}
        </Button>
      </div>
      <ErrorLine message={error} />
    </form>
  );
}

export function FollowUpControl({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await setFollowUp(leadId, when, note);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setWhen("");
      setNote("");
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <Label htmlFor="follow-up-at" className="text-xs text-slate-500">
          Follow up at
        </Label>
        <Input
          id="follow-up-at"
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="mt-1.5 h-9"
          disabled={isPending}
          required
        />
      </div>

      <div>
        <Label htmlFor="follow-up-note" className="text-xs text-slate-500">
          Note (optional)
        </Label>
        <Input
          id="follow-up-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Call back about pricing"
          className="mt-1.5 h-9"
          disabled={isPending}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        {/*
          Stated plainly because the alternative is a staff member trusting a
          reminder that does not exist. Notifications are V1.1; this records
          the intent on the audit trail and nothing more.
        */}
        <p className="text-xs text-slate-400">
          Recorded on the activity trail. No reminder is sent yet.
        </p>
        <Button type="submit" size="sm" disabled={isPending || !when}>
          {isPending ? "Saving…" : "Set follow-up"}
        </Button>
      </div>

      {saved && <p className="text-sm text-emerald-700">Follow-up recorded.</p>}
      <ErrorLine message={error} />
    </form>
  );
}
