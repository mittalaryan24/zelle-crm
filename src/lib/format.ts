import type { Activity, TranscriptMessage } from "@/lib/types";

/**
 * AI score colour bands, per the brief: green 80+, yellow 50-79, red below 50.
 *
 * A null score is grey rather than red. "Not scored" and "scored badly" are
 * different facts, and painting the first one red invents a judgement the AI
 * never made.
 */
export function scoreBand(score: number | null): "none" | "low" | "mid" | "high" {
  if (score === null || score === undefined) return "none";
  if (score >= 80) return "high";
  if (score >= 50) return "mid";
  return "low";
}

export const SCORE_BAND_CLASSES: Record<
  ReturnType<typeof scoreBand>,
  string
> = {
  high: "bg-emerald-100 text-emerald-800 border-emerald-200",
  mid: "bg-amber-100 text-amber-900 border-amber-200",
  low: "bg-red-100 text-red-800 border-red-200",
  none: "bg-slate-100 text-slate-500 border-slate-200",
};

export const CHANNEL_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
};

export const CHANNEL_CLASSES: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-800 border-pink-200",
  facebook: "bg-blue-100 text-blue-800 border-blue-200",
  whatsapp: "bg-green-100 text-green-800 border-green-200",
};

/**
 * Strip a phone number down to what wa.me accepts: digits only, no leading +.
 *
 * wa.me rejects spaces, dashes and parentheses, and the fixture numbers have
 * all three ("+91 98200 11111"). Returns null when nothing usable is left, so
 * callers can hide the button rather than render a link to wa.me/.
 *
 * Deliberately does NOT try to add a country code. Guessing one would send the
 * message to a real person in the wrong country; better to require that the
 * upstream data carries it.
 */
export function whatsappNumber(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  // Shortest plausible international number is ~7 digits after the country code.
  return digits.length >= 8 ? digits : null;
}

/** `tel:` is far more forgiving than wa.me — it only needs the junk removed. */
export function telNumber(phone: string | null): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, "");
  return cleaned.length >= 6 ? cleaned : null;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDateTime(iso);
}

/**
 * Coerce whatever is in conversations.messages into a single shape.
 *
 * See TranscriptMessage for why two shapes exist. Anything unrecognisable is
 * dropped rather than rendered as "[object Object]" — a transcript is context
 * for a human, and a garbled line is worse than a missing one.
 */
export function normalizeMessages(raw: unknown): TranscriptMessage[] {
  if (!Array.isArray(raw)) return [];

  const out: TranscriptMessage[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;

    const text = typeof m.text === "string" ? m.text : null;
    if (text === null) continue;

    // Stage 2 uses `sender: "ai" | "lead"`; the Stage 1 fixture uses
    // `role: "assistant" | "user"`. Treat anything not explicitly the bot as
    // the lead — mislabelling the AI as the customer is the more confusing
    // error of the two.
    const senderRaw =
      typeof m.sender === "string"
        ? m.sender
        : typeof m.role === "string"
          ? m.role
          : "";
    const sender: TranscriptMessage["sender"] =
      senderRaw === "ai" || senderRaw === "assistant" ? "ai" : "lead";

    const atRaw = m.timestamp ?? m.at;
    const at = typeof atRaw === "string" ? atRaw : null;

    out.push({ sender, text, at });
  }

  return out;
}

/**
 * Turn one activity row into a human sentence.
 *
 * The brief asks for "Status changed from X to Y", not raw JSON. That is harder
 * than it looks, because the same activity type carries different content keys
 * depending on who wrote it:
 *
 *   status_change  Stage 1 fixture / n8n  { from, to }
 *                  this UI (per brief)    { old_status, new_status }
 *   follow_up_set  Stage 1 fixture        { due_at, channel }
 *                  this UI (per brief)    { follow_up_date, note }
 *
 * Both are read here. New rows written by this app use the shapes the brief
 * specifies; old rows still render correctly instead of falling through to a
 * JSON dump.
 */
export function describeActivity(activity: Activity): string {
  const c = activity.content ?? {};
  const str = (key: string): string | null =>
    typeof c[key] === "string" && c[key] !== "" ? (c[key] as string) : null;

  switch (activity.type) {
    case "status_change": {
      const from = str("old_status") ?? str("from");
      const to = str("new_status") ?? str("to");
      if (from && to) return `Status changed from ${from} to ${to}`;
      if (to) return `Status set to ${to}`;
      return "Status changed";
    }

    case "note": {
      const text = str("text");
      return text ? `Note: ${text}` : "Note added";
    }

    case "assignment": {
      const name = str("assigned_to_name");
      const result = str("result");
      if (result === "unassigned" || (!name && c.assigned_to === null)) {
        return "Round-robin could not assign this lead — no active staff";
      }
      const rule = str("rule");
      const suffix = rule === "round_robin" ? " by round-robin" : "";
      return name ? `Assigned to ${name}${suffix}` : `Assigned${suffix}`;
    }

    case "call_logged": {
      const outcome = str("outcome");
      const notes = str("notes");
      const head = outcome ? `Call logged (${outcome})` : "Call logged";
      return notes ? `${head}: ${notes}` : head;
    }

    case "follow_up_set": {
      const due = str("follow_up_date") ?? str("due_at");
      const note = str("note");
      const head = due ? `Follow-up set for ${formatDateTime(due)}` : "Follow-up set";
      return note ? `${head} — ${note}` : head;
    }

    case "ai_qualified": {
      const score = typeof c.score === "number" ? c.score : null;
      const summary = str("summary");
      const head =
        score === null ? "Qualified by AI" : `Qualified by AI with a score of ${score}`;
      return summary ? `${head}: ${summary}` : head;
    }

    default:
      return "Activity recorded";
  }
}

/** Who did it. Falls back gracefully for the audit-trail tombstone case. */
export function describeActor(activity: Activity): string {
  switch (activity.actor_type) {
    case "ai":
      return "AI assistant";
    case "system":
      return "System";
    case "user":
      // actor_id is nulled when a user is deleted (ON DELETE SET NULL in
      // migration 001), leaving actor_type 'user' with nobody attached.
      return activity.actor_name ?? "A removed user";
    default:
      return "Unknown";
  }
}
