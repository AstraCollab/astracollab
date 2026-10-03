import { describe, expect, it } from "vitest";

import { createMastraSessionStore, sessionUpdateFor } from "./store.js";
import { planRowMigration, runRowMigration } from "./migrate.js";
import type { MastraMessage } from "./index.js";

/**
 * The store adapter and the one-pass row migration.
 *
 * The failure both of these exist to prevent is silent and specific: the mapper
 * changes how many messages a set of rows becomes, so any count taken from rows
 * rather than from the mapped array re-writes history that was already stored. It
 * does not throw. It just duplicates.
 */

type Row = MastraMessage & { id: string };

const rows = (...parts: Array<Record<string, unknown>>): Row[] => [
  {
    id: "r1",
    role: "assistant",
    content: {
      format: 2,
      parts: [
        {
          type: "tool-invocation",
          toolCallId: "t1",
          toolName: "read",
          toolInvocation: { toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "contents" },
        },
      ],
    },
  },
];

/** A Mastra-shaped source backed by an array, so writes are inspectable. */
const arraySource = (initial: Row[]) => {
  const state = { rows: [...initial], writes: 0, replaces: 0 };
  return {
    state,
    source: {
      load: async () => state.rows,
      append: async (_thread: string, added: Row[]) => {
        state.writes += 1;
        state.rows = [...state.rows, ...added];
      },
      replace: async (_thread: string, replaced: Row[]) => {
        state.replaces += 1;
        state.rows = [...replaced];
      },
    },
  };
};

const storeFor = (initial: Row[]) => {
  const { state, source } = arraySource(initial);
  const store = createMastraSessionStore<Row>({
    threadId: "th",
    rows: source,
    toMessage: (row) => row,
    idFor: (index) => `w${index}`,
  });
  return { state, store };
};

describe("the store adapter", () => {
  it("maps rows to messages, splitting one tool call into two", async () => {
    const { store } = storeFor(rows({}));
    const messages = await store.load();
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
  });

  it("reports the mapped count, not the row count", async () => {
    // 1 row becomes 2 messages. Handing `sessionUpdate` the row count would
    // re-append a stored message on every turn.
    const { store } = storeFor(rows({}));
    await store.load();
    expect(store.loadedCount).toBe(2);
  });

  it("appends only the new tail when the count comes from loadedCount", async () => {
    const { state, store } = storeFor(rows({}));
    const before = await store.load();
    expect(before).toHaveLength(2);

    const turn = [...before, { role: "assistant" as const, content: [{ type: "text", text: "done" }] }];
    await store.append([turn[2]!]);

    const update = sessionUpdateFor(store.loadedCount, { messages: turn, compactions: 0 });
    expect(update).toEqual({ mode: "append", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
    expect(state.writes).toBe(1);
    // The new message was written once, on top of what was already stored.
    expect(state.rows).toHaveLength(2);
  });

  it("shows what the row count would have cost", async () => {
    // The reason loadedCount exists, stated as a test so it cannot be deleted as
    // redundant.
    const { store } = storeFor(rows({}));
    const before = await store.load();
    const turn = [...before, { role: "assistant" as const, content: [{ type: "text", text: "new" }] }];
    const wrong = sessionUpdateFor(1, { messages: turn, compactions: 0 });
    expect(wrong.mode).toBe("append");
    expect(wrong.messages).toHaveLength(3 - 1);
    expect(sessionUpdateFor(store.loadedCount, { messages: turn, compactions: 0 }).messages).toHaveLength(1);
  });

  it("replaces the whole thread when the run compacted", async () => {
    const { state, store } = storeFor(rows({}));
    await store.load();
    const compacted = [{ role: "assistant" as const, content: [{ type: "text", text: "summary of the above" }] }];
    await store.replace(compacted);

    expect(state.replaces).toBe(1);
    expect(state.rows.map((row) => (row.content as { parts: Array<{ text?: string }> }).parts[0]?.text)).toEqual([
      "summary of the above",
    ]);
  });

  it("keeps a tool result with the call when writing back", async () => {
    const { state, store } = storeFor(rows({}));
    await store.load();
    const messages = await store.load();
    await store.replace(messages);

    const parts = (state.rows[0]!.content as { parts: Array<{ toolInvocation?: { result?: string } }> }).parts;
    expect(parts[0]!.toolInvocation?.result).toBe("contents");
  });

  it("empties the thread on reset", async () => {
    const { state, store } = storeFor(rows({}));
    await store.load();
    await store.reset();
    expect(state.rows).toEqual([]);
    expect(store.loadedCount).toBe(0);
  });

  it("absorbs a caller that appends the whole transcript", async () => {
    // The natural mistake, and the one this package exists to prevent: pass
    // `result.messages` instead of the delta and every stored turn is written
    // again. Found by running it against the published build in a real repo.
    const { state, store } = storeFor(rows({}));
    const loaded = await store.load();
    const turn = [...loaded, { role: "assistant" as const, content: [{ type: "text", text: "done" }] }];
    await store.append(turn);

    expect(store.skippedDuplicates).toBe(2);
    // 1 original row, plus the one new turn — not the transcript again.
    expect(state.rows).toHaveLength(2);
  });

  it("still appends a genuine tail", async () => {
    const { state, store } = storeFor(rows({}));
    const loaded = await store.load();
    await store.append([{ role: "assistant" as const, content: [{ type: "text", text: "next" }] }]);
    expect(store.skippedDuplicates).toBe(0);
    expect(state.rows).toHaveLength(2);
  });

  it("is a no-op when there is nothing to append", async () => {
    const { state, store } = storeFor(rows({}));
    await store.append([]);
    expect(state.writes).toBe(0);
  });
});

describe("the row migration", () => {
  it("converts Mastra rows and splits tool calls onto their own rows", () => {
    const plan = planRowMigration(rows({}));
    expect(plan.report.upgraded).toBe(1);
    expect(plan.report.toolCallsSplit).toBe(1);
    expect(plan.rows.map((row) => row.role)).toEqual(["assistant", "tool"]);
    expect(plan.rows[1]!.content[0]).toMatchObject({ type: "tool-result", toolCallId: "t1", output: "contents" });
  });

  it("passes an already-migrated row through untouched", () => {
    const migrated = [{ id: "a1", role: "assistant" as const, content: [{ type: "text", text: "already done" }] }];
    const plan = planRowMigration(migrated);
    expect(plan.report.alreadyMigrated).toBe(1);
    expect(plan.report.upgraded).toBe(0);
    expect(plan.rows).toEqual(migrated);
  });

  it("is idempotent, because a migration that runs twice must not duplicate", () => {
    const once = planRowMigration(rows({}));
    const twice = planRowMigration(once.rows);
    expect(twice.rows).toEqual(once.rows);
    expect(twice.report.alreadyMigrated).toBe(once.rows.length);
  });

  it("gives every migrated row a stable id", () => {
    // A thread is rewritten on every turn; an unstable id duplicates rows instead
    // of replacing them.
    const first = planRowMigration(rows({})).rows.map((row) => row.id);
    const second = planRowMigration(rows({})).rows.map((row) => row.id);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it("honours a custom id scheme", () => {
    const plan = planRowMigration(rows({}), { idFor: (source, index) => `${source}-${index}` });
    expect(plan.rows.map((row) => row.id)).toEqual(["r1-0", "r1-1"]);
  });

  it("preserves unmappable parts rather than dropping them", () => {
    const plan = planRowMigration(
      [
        {
          id: "r9",
          role: "assistant",
          content: { format: 2, parts: [{ type: "source-document", sourceId: "d1" }, { type: "text", text: "read it" }] },
        },
      ],
      { onUnknownPart: "preserve" },
    );
    expect(plan.report.unmappedParts).toBe(1);
    expect(JSON.stringify(plan.rows)).toContain("source-document");
  });

  it("reports a row it could not read instead of dropping it silently", () => {
    const plan = planRowMigration([
      { id: "empty", role: "assistant", content: { format: 2, parts: [] } },
    ], { onUnknownPart: "preserve" });
    expect(plan.report.droppedMessages).toBe(1);
    expect(plan.rows).toEqual([]);
  });

  it("fails loudly by default rather than preserving silently", () => {
    expect(() =>
      planRowMigration([
        { id: "r", role: "assistant", content: { format: 2, parts: [{ type: "source-document", sourceId: "d" }] } },
      ]),
    ).toThrow(/source-document/);
  });

  it("batches the writes", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      id: `r${index}`,
      role: "assistant" as const,
      content: { format: 2 as const, parts: [{ type: "text", text: `m${index}` }] },
    }));
    const plan = planRowMigration(many, { batchSize: 3 });
    expect(plan.batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(plan.report.rowsOut).toBe(7);
  });

  it("applies each batch once and reports progress", async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      id: `r${index}`,
      role: "assistant" as const,
      content: { format: 2 as const, parts: [{ type: "text", text: `m${index}` }] },
    }));
    const batches: number[] = [];
    const progress: number[] = [];
    const report = await runRowMigration(many, {
      batchSize: 2,
      apply: (batch) => {
        batches.push(batch.length);
      },
      onProgress: (written) => progress.push(written),
    });
    expect(batches).toEqual([2, 2, 1]);
    expect(progress).toEqual([2, 4, 5]);
    expect(report.rowsOut).toBe(5);
  });

  it("leaves the mapper off the hot path afterwards", async () => {
    // The point of migrating: a store holding AI SDK rows never needs the Mastra
    // mapper again, so a change to one side cannot break the other path.
    const plan = planRowMigration(rows({}));
    const readBack = plan.rows.flatMap((row) =>
      row.role === "tool"
        ? [{ role: "tool" as const, content: row.content }]
        : [{ role: row.role, content: row.content }],
    );
    expect(readBack.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(plan.report.alreadyMigrated).toBe(0);
  });
});