/**
 * One-pass migration from Mastra rows to AI SDK rows.
 *
 * The mapper has to run on every read to produce `ModelMessage[]`, and on every
 * write to go back. That is fine, but it means the store keeps two shapes alive
 * for as long as it keeps both formats — and the day a part type is added to one
 * side, only one of the two paths gets fixed.
 *
 * So: convert the rows once, then stop mapping. After this runs, the store holds
 * AI SDK rows, `fromMastra` leaves the hot path, and the only thing left is
 * ordinary message persistence.
 *
 * Two properties the migration has to have, or it is not safe to run twice:
 *
 * - **Deterministic ids.** A row that already exists must be replaced, not
 *   duplicated, and a thread is rewritten on every turn.
 * - **Detection, not a flag.** A row is recognised as already migrated by its
 *   shape, so the migration needs no column and no bookkeeping of its own.
 */
import type { ModelMessage } from "ai";

import { fromMastra, type MastraMessage } from "./index.js";

/** An AI SDK row, as stored. Deliberately plain — no provenance column to add. */
export type AiSdkRow = {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: Array<Record<string, unknown>>;
};

export type RowMigrationReport = {
  rowsIn: number;
  rowsOut: number;
  /** Already AI SDK shaped, so passed through untouched. */
  alreadyMigrated: number;
  /** Mastra rows converted. */
  upgraded: number;
  /** Tool calls whose result moved onto its own row. */
  toolCallsSplit: number;
  /** Parts with no equivalent, preserved under `providerOptions`. */
  unmappedParts: number;
  /**
   * Messages that produced nothing.
   *
   * Non-zero means rows were unreadable — an empty assistant message, or a body
   * the mapper does not recognise. They are reported rather than dropped, because
   * a migration that quietly loses rows is the one thing it must never do.
   */
  droppedMessages: number;
};

export type RowMigrationPlan = {
  rows: AiSdkRow[];
  batches: AiSdkRow[][];
  report: RowMigrationReport;
};

export type PlanRowMigrationOptions = {
  /**
   * Stable id for a migrated row.
   *
   * The default derives from the source row id, so re-running produces identical
   * ids and the write is an upsert. A tool result split onto its own row gets a
   * suffix for the same reason.
   */
  idFor?: (sourceId: string, index: number) => string;
  /** Rows per batch. */
  batchSize?: number;
  /** Carry unmappable parts through instead of failing. */
  onUnknownPart?: "throw" | "preserve";
};

/**
 * Already in the AI SDK shape.
 *
 * Shape-based rather than flag-based on purpose: a flag needs a column, a
 * migration to add it, and a backfill to populate it, and any of those can be
 * half-done. `content` being an array with no `parts` is what an AI SDK row looks
 * like, and Mastra's `content` is an object.
 */
const isAiSdkRow = (row: unknown): row is AiSdkRow => {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as { role?: unknown; content?: unknown };
  if (typeof candidate.role !== "string" || !Array.isArray(candidate.content)) return false;
  // An AI SDK row's content is the parts array itself; a Mastra row's content is
  // an object that *contains* one.
  return true;
};

const countToolCalls = (messages: ModelMessage[]): number =>
  messages.reduce(
    (total, message) =>
      total +
      (message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((part) => (part as { type?: string }).type === "tool-call").length
        : 0),
    0,
  );

/** Turns one stored row into zero or more AI SDK rows. */
const migrateRow = (
  row: MastraMessage | AiSdkRow,
  index: number,
  options: Required<Pick<PlanRowMigrationOptions, "idFor" | "onUnknownPart">>,
  report: RowMigrationReport,
): AiSdkRow[] => {
  if (isAiSdkRow(row)) {
    report.alreadyMigrated += 1;
    return [{ id: row.id, role: row.role, content: row.content }];
  }

  const messages = fromMastra([row], { onUnknownPart: options.onUnknownPart });
  if (messages.length === 0) {
    report.droppedMessages += 1;
    return [];
  }

  report.upgraded += 1;
  report.toolCallsSplit += countToolCalls(messages);
  const sourceId = row.id ?? `row-${index}`;

  const out: AiSdkRow[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ id: options.idFor(sourceId, out.length), role: "system", content: [{ type: "text", text: String(message.content) }] });
      continue;
    }
    const content = Array.isArray(message.content)
      ? (message.content as unknown as Array<Record<string, unknown>>)
      : [{ type: "text", text: String(message.content) }];
    for (const part of content) {
      const held = (part.providerOptions as { astracollab?: { unmappedParts?: unknown[] } } | undefined)?.astracollab
        ?.unmappedParts;
      if (Array.isArray(held)) report.unmappedParts += held.length;
    }
    out.push({ id: options.idFor(sourceId, out.length), role: message.role, content });
  }
  return out;
};

/**
 * Plan the whole migration without touching a database.
 *
 * Returned rather than applied so a caller can read `report` first: a migration
 * that reports how many rows it could not read is worth looking at before it
 * rewrites a table.
 */
export const planRowMigration = (
  rows: readonly (MastraMessage | AiSdkRow)[],
  options: PlanRowMigrationOptions = {},
): RowMigrationPlan => {
  const resolved = {
    idFor: options.idFor ?? ((sourceId: string, index: number) => `${sourceId}${index === 0 ? "" : `-${index}`}`),
    onUnknownPart: options.onUnknownPart ?? ("throw" as const),
  };
  const report: RowMigrationReport = {
    rowsIn: rows.length,
    rowsOut: 0,
    alreadyMigrated: 0,
    upgraded: 0,
    toolCallsSplit: 0,
    unmappedParts: 0,
    droppedMessages: 0,
  };

  const migrated: AiSdkRow[] = [];
  rows.forEach((row, index) => {
    migrated.push(...migrateRow(row, index, resolved, report));
  });
  report.rowsOut = migrated.length;

  const batchSize = Math.max(1, options.batchSize ?? 500);
  const batches: AiSdkRow[][] = [];
  for (let at = 0; at < migrated.length; at += batchSize) {
    batches.push(migrated.slice(at, at + batchSize));
  }

  return { rows: migrated, batches, report };
};

export type RunRowMigrationOptions = PlanRowMigrationOptions & {
  /** Write one batch. Called once per batch, in order. */
  apply: (batch: AiSdkRow[], batchIndex: number) => Promise<void> | void;
  /** Called after every batch, so progress can be reported on a long run. */
  onProgress?: (written: number, total: number) => void;
};

/**
 * Plan and apply.
 *
 * `apply` is supplied rather than assumed so this works against a Mastra store, a
 * Prisma client, or a raw `pg` query, and so a test can count the writes without
 * a database.
 */
export const runRowMigration = async (
  rows: readonly (MastraMessage | AiSdkRow)[],
  options: RunRowMigrationOptions,
): Promise<RowMigrationReport> => {
  const plan = planRowMigration(rows, options);
  let written = 0;
  for (const [index, batch] of plan.batches.entries()) {
    await options.apply(batch, index);
    written += batch.length;
    options.onProgress?.(written, plan.rows.length);
  }
  return plan.report;
};