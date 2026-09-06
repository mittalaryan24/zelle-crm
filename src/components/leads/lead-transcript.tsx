"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import type { TranscriptMessage } from "@/lib/types";

/**
 * The AI/customer transcript, collapsed by default per the brief.
 *
 * This is also the "Instagram action" the brief describes: there is deliberately
 * no "open Instagram" button anywhere on this screen. Instagram has no reliable
 * deep link to a specific DM thread, so such a button would drop staff on a
 * profile page or the app's home screen and call it a handoff. Reading the
 * transcript here and continuing manually in Instagram is the honest workflow.
 */
export function LeadTranscript({ messages }: { messages: TranscriptMessage[] }) {
  const [expanded, setExpanded] = useState(false);

  if (messages.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No conversation was captured for this lead.
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-slate-500">
          {messages.length} {messages.length === 1 ? "message" : "messages"}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="lead-transcript"
        >
          {expanded ? "Collapse" : "Expand transcript"}
        </Button>
      </div>

      {expanded && (
        <div id="lead-transcript" className="mt-4 space-y-3">
          {messages.map((message, index) => {
            const isAi = message.sender === "ai";
            return (
              <div
                // Transcript messages carry no id, and the array is read-only
                // and never reordered, so the index is a stable key here.
                key={index}
                className={isAi ? "flex justify-start" : "flex justify-end"}
              >
                <div
                  className={
                    "max-w-[80%] rounded-lg px-3 py-2 text-sm " +
                    (isAi
                      ? "bg-slate-100 text-slate-800"
                      : "bg-blue-600 text-white")
                  }
                >
                  <div className="mb-0.5 text-xs font-medium opacity-70">
                    {isAi ? "AI assistant" : "Lead"}
                    {message.at && ` · ${formatDateTime(message.at)}`}
                  </div>
                  <div className="whitespace-pre-wrap">{message.text}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
