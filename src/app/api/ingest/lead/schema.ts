import { z } from "zod";

/**
 * Shape of the payload n8n posts to /api/ingest/lead.
 *
 * Validation happens here, before any database work, so a malformed request
 * produces a clear 400 that names the offending fields rather than a confusing
 * 500 from a constraint violation deeper down.
 *
 * NOTE ON organization_id — there is deliberately no field for it. Zod strips
 * unrecognised keys by default, so if a misconfigured workflow sends one it is
 * discarded rather than honoured. The organization is derived from the API key
 * inside ingest_lead(); nothing in this payload can influence it.
 */

const isoTimestamp = z
  .string()
  .min(1, "is required")
  // Not z.string().datetime(), which insists on a narrow RFC 3339 subset.
  // Upstream platforms are inconsistent about offsets and fractional seconds,
  // and rejecting a valid-but-unusual timestamp would mean dropping a real
  // lead. Anything JavaScript can parse as a date is accepted.
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "must be an ISO 8601 timestamp, e.g. 2026-03-02T09:14:00Z",
  });

const messageSchema = z.object({
  sender: z.enum(["ai", "lead"], {
    errorMap: () => ({ message: "must be either 'ai' or 'lead'" }),
  }),
  text: z.string(),
  timestamp: isoTimestamp,
});

export const ingestLeadSchema = z.object({
  channel: z.enum(["instagram", "facebook", "whatsapp"], {
    errorMap: () => ({
      message: "must be one of 'instagram', 'facebook', 'whatsapp'",
    }),
  }),

  source: z.string().min(1, "is required").max(100),

  // The idempotency key. Without it a retried webhook silently creates a
  // duplicate lead, so it is required rather than optional.
  source_message_id: z.string().min(1, "is required").max(255),

  lead: z.object({
    name: z.string().min(1, "is required").max(200),
    phone: z.string().max(50).optional(),
  }),

  ai_qualification: z.object({
    // Bounded here to match the CHECK constraint on leads.ai_score, so an
    // out-of-range score returns a readable 400 instead of a database error.
    score: z
      .number()
      .int("must be a whole number")
      .min(0, "must be between 0 and 100")
      .max(100, "must be between 0 and 100"),
    summary: z.string().min(1, "is required"),
    // Arbitrary org-specific keys, matching qualification_field_defs.field_key.
    // Must be an object — leads.qualification_data has a CHECK enforcing that.
    fields: z.record(z.string(), z.unknown()),
  }),

  conversation: z.object({
    // May be empty: a lead with no transcript is still a lead worth keeping.
    messages: z.array(messageSchema),
  }),
});

export type IngestLeadPayload = z.infer<typeof ingestLeadSchema>;

/**
 * Turn Zod's issue list into flat, human-readable strings.
 *
 * `["lead.name: is required", "ai_qualification.score: must be between 0 and 100"]`
 *
 * These go straight into the 400 response body so whoever is looking at the n8n
 * execution log can see what to fix without reading this file.
 */
export function formatValidationErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
