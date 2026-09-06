"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  addPipelineStage,
  addQualificationField,
  deletePipelineStage,
  deleteQualificationField,
  moveQualificationField,
  movePipelineStage,
  renamePipelineStage,
  renameQualificationField,
} from "@/app/(app)/settings/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PipelineStage, QualificationFieldDef } from "@/lib/types";

/** Small shared helper: run an action, surface its error, refresh on success. */
function useAction() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      router.refresh();
    });
  };

  return { run, isPending, error, setError };
}

function ReorderButtons({
  onUp,
  onDown,
  isFirst,
  isLast,
  disabled,
}: {
  onUp: () => void;
  onDown: () => void;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-0.5">
      <Button
        type="button" size="icon-sm" variant="ghost"
        onClick={onUp} disabled={disabled || isFirst} aria-label="Move up"
      >
        ↑
      </Button>
      <Button
        type="button" size="icon-sm" variant="ghost"
        onClick={onDown} disabled={disabled || isLast} aria-label="Move down"
      >
        ↓
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Qualification fields
// ---------------------------------------------------------------------------

export function QualificationFieldsEditor({
  fields,
}: {
  fields: QualificationFieldDef[];
}) {
  const { run, isPending, error } = useAction();
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");

  return (
    <div className="space-y-4">
      {fields.length === 0 ? (
        <p className="text-sm text-slate-500">
          No qualification fields defined. Anything the AI sends will still be stored on
          the lead, but it will render under its raw key.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {fields.map((field, index) => (
            <QualificationFieldRow
              key={field.id}
              field={field}
              isFirst={index === 0}
              isLast={index === fields.length - 1}
            />
          ))}
        </ul>
      )}

      <form
        className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const result = await addQualificationField(newKey, newLabel);
            if (result.ok) {
              setNewKey("");
              setNewLabel("");
            }
            return result;
          });
        }}
      >
        <div>
          <Label htmlFor="new-field-key" className="text-xs text-slate-500">
            Field key
          </Label>
          <Input
            id="new-field-key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="budget_month"
            className="mt-1.5 h-9 font-mono text-xs"
            disabled={isPending}
          />
        </div>
        <div>
          <Label htmlFor="new-field-label" className="text-xs text-slate-500">
            Label
          </Label>
          <Input
            id="new-field-label"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Monthly budget"
            className="mt-1.5 h-9"
            disabled={isPending}
          />
        </div>
        <Button
          type="submit" size="sm" className="h-9"
          disabled={isPending || !newKey.trim() || !newLabel.trim()}
        >
          Add field
        </Button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

function QualificationFieldRow({
  field,
  isFirst,
  isLast,
}: {
  field: QualificationFieldDef;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { run, isPending, error } = useAction();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(field.label);
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
        {field.field_key}
      </code>

      {editing ? (
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const result = await renameQualificationField(field.id, label);
              if (result.ok) setEditing(false);
              return result;
            });
          }}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="h-8"
            disabled={isPending}
            autoFocus
          />
          <Button type="submit" size="sm" disabled={isPending}>Save</Button>
          <Button
            type="button" size="sm" variant="ghost"
            onClick={() => { setLabel(field.label); setEditing(false); }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <span className="flex-1 text-sm text-slate-900">{field.label}</span>

          <ReorderButtons
            isFirst={isFirst}
            isLast={isLast}
            disabled={isPending}
            onUp={() => run(() => moveQualificationField(field.id, "up"))}
            onDown={() => run(() => moveQualificationField(field.id, "down"))}
          />

          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Rename
          </Button>

          {confirming ? (
            <span className="flex items-center gap-1.5">
              <Button
                type="button" size="sm" variant="destructive" disabled={isPending}
                onClick={() => run(() => deleteQualificationField(field.id))}
              >
                Confirm delete
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}
        </>
      )}

      {error && <p role="alert" className="w-full text-xs text-red-600">{error}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

export function PipelineStagesEditor({
  stages,
  leadCountByStage,
}: {
  stages: PipelineStage[];
  /** How many leads currently sit in each stage — drives the orphan warning. */
  leadCountByStage: Record<string, number>;
}) {
  const { run, isPending, error } = useAction();
  const [newName, setNewName] = useState("");

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-slate-100">
        {stages.map((stage, index) => (
          <PipelineStageRow
            key={stage.id}
            stage={stage}
            stages={stages}
            leadCount={leadCountByStage[stage.name] ?? 0}
            isFirst={index === 0}
            isLast={index === stages.length - 1}
            isOnly={stages.length === 1}
          />
        ))}
      </ul>

      <form
        className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-[1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const result = await addPipelineStage(newName);
            if (result.ok) setNewName("");
            return result;
          });
        }}
      >
        <div>
          <Label htmlFor="new-stage-name" className="text-xs text-slate-500">
            Stage name
          </Label>
          <Input
            id="new-stage-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Proposal sent"
            className="mt-1.5 h-9"
            disabled={isPending}
          />
        </div>
        <Button type="submit" size="sm" className="h-9" disabled={isPending || !newName.trim()}>
          Add stage
        </Button>
      </form>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function PipelineStageRow({
  stage,
  stages,
  leadCount,
  isFirst,
  isLast,
  isOnly,
}: {
  stage: PipelineStage;
  stages: PipelineStage[];
  leadCount: number;
  isFirst: boolean;
  isLast: boolean;
  isOnly: boolean;
}) {
  const { run, isPending, error } = useAction();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(stage.name);
  const [confirming, setConfirming] = useState(false);
  const [moveTo, setMoveTo] = useState(
    stages.find((s) => s.id !== stage.id)?.name ?? "",
  );

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-6 text-xs tabular-nums text-slate-400">
          {stage.order_index}
        </span>

        {editing ? (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const result = await renamePipelineStage(stage.id, name);
                if (result.ok) setEditing(false);
                return result;
              });
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8"
              disabled={isPending}
              autoFocus
            />
            <Button type="submit" size="sm" disabled={isPending}>Save</Button>
            <Button
              type="button" size="sm" variant="ghost"
              onClick={() => { setName(stage.name); setEditing(false); }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <span className="flex-1 text-sm font-medium text-slate-900">{stage.name}</span>
            <span className="text-xs text-slate-500">
              {leadCount} {leadCount === 1 ? "lead" : "leads"}
            </span>

            <ReorderButtons
              isFirst={isFirst}
              isLast={isLast}
              disabled={isPending}
              onUp={() => run(() => movePipelineStage(stage.id, "up"))}
              onDown={() => run(() => movePipelineStage(stage.id, "down"))}
            />

            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Rename
            </Button>

            {!confirming && (
              <Button
                type="button" size="sm" variant="ghost"
                disabled={isOnly}
                title={isOnly ? "An organization needs at least one stage" : undefined}
                onClick={() => setConfirming(true)}
              >
                Delete
              </Button>
            )}
          </>
        )}
      </div>

      {/*
        The orphan warning the brief asks for. leads.status is free text, not a
        foreign key, so deleting a stage would leave those leads pointing at a
        name that no longer exists — still readable, but absent from the funnel
        and shown as "(not in pipeline)" on the profile. So the count is stated
        up front and a destination is required before the delete is allowed.
      */}
      {confirming && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          {leadCount > 0 ? (
            <>
              <p className="text-sm text-amber-900">
                <strong>{leadCount}</strong> {leadCount === 1 ? "lead is" : "leads are"}{" "}
                currently in <strong>{stage.name}</strong>. Deleting it would leave{" "}
                {leadCount === 1 ? "that lead" : "those leads"} with a status that matches
                no stage — they would drop out of the funnel. Move them first:
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  aria-label="Move those leads to"
                  className="h-8 rounded-md border border-amber-300 bg-white px-2 text-sm"
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value)}
                  disabled={isPending}
                >
                  {stages
                    .filter((s) => s.id !== stage.id)
                    .map((s) => (
                      <option key={s.id} value={s.name}>{s.name}</option>
                    ))}
                </select>
                <Button
                  type="button" size="sm" variant="destructive" disabled={isPending || !moveTo}
                  onClick={() => run(() => deletePipelineStage(stage.id, moveTo))}
                >
                  Move {leadCount} and delete
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-amber-900">
                No leads are in <strong>{stage.name}</strong>. Safe to delete.
              </p>
              <Button
                type="button" size="sm" variant="destructive" disabled={isPending}
                onClick={() => run(() => deletePipelineStage(stage.id, null))}
              >
                Confirm delete
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}
