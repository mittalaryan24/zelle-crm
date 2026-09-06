/**
 * Domain types, hand-written to mirror the migrations.
 *
 * Supabase can generate these from the live database (`supabase gen types`),
 * which is worth adopting once the schema settles. Hand-writing them now keeps
 * Stage 3 free of a codegen step, and these are narrow enough to check by eye
 * against migration 001.
 */

export type Role = "admin" | "staff";

export type Channel = "instagram" | "facebook" | "whatsapp";

export type ActivityType =
  | "status_change"
  | "note"
  | "assignment"
  | "call_logged"
  | "follow_up_set"
  | "ai_qualified";

export type ActorType = "ai" | "user" | "system";

/** The signed-in person, joined with their organization. */
export interface Profile {
  id: string;
  organization_id: string | null;
  name: string | null;
  email: string | null;
  role: Role;
  is_active: boolean;
  organization_name: string | null;
}

export interface Lead {
  id: string;
  organization_id: string;
  assigned_to: string | null;
  name: string | null;
  phone: string | null;
  channel: Channel;
  source: string | null;
  ai_score: number | null;
  ai_summary: string | null;
  status: string;
  qualification_data: Record<string, unknown>;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A lead as the inbox needs it: with the assignee's name resolved. */
export interface LeadWithAssignee extends Lead {
  assignee_name: string | null;
}

export interface PipelineStage {
  id: string;
  name: string;
  order_index: number;
}

export interface QualificationFieldDef {
  id: string;
  field_key: string;
  label: string;
  order_index: number;
}

export interface OrgMember {
  id: string;
  name: string | null;
  email: string | null;
  role: Role;
  is_active: boolean;
}

export interface Activity {
  id: string;
  lead_id: string;
  actor_type: ActorType;
  actor_id: string | null;
  type: ActivityType;
  content: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
}

/**
 * One transcript message, normalized.
 *
 * The conversations.messages jsonb holds two different shapes in practice, and
 * both are live in the database right now:
 *
 *   Stage 1 fixture  { role: "user" | "assistant", text, at }
 *   Stage 2 ingest   { sender: "lead" | "ai",      text, timestamp }
 *
 * Neither is wrong — the column is schemaless jsonb with only a "must be an
 * array" CHECK on it. Rather than migrate historic rows, the profile screen
 * normalizes both into this shape at read time. See normalizeMessages().
 */
export interface TranscriptMessage {
  sender: "ai" | "lead";
  text: string;
  at: string | null;
}
