import { describe, expect, it } from "vitest";

import { alignTailToToolBoundary, compactMessages } from "../src/compaction.js";
import type { ModelMessage } from "ai";

const call = (id: string) =>
  ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
  }) as unknown as ModelMessage;

const result = (id: string) =>
  ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "read",
        output: { type: "text", value: id.repeat(400) },
      },
    ],
  }) as unknown as ModelMessage;

const transcript = (rounds: number): ModelMessage[] => [
  { role: "user", content: "add a docs section" },
  ...Array.from({ length: rounds }, (_, i) => [call(`c${i}`), result(`c${i}`)]).flat(),
];

const orphanIds = (messages: ModelMessage[]): { orphans: string[]; unanswered: string[] } => {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === "tool-call") calls.add(part.toolCallId as string);
      if (part.type === "tool-result") results.add(part.toolCallId as string);
    }
  }
  return {
    orphans: [...results].filter((id) => !calls.has(id)),
    unanswered: [...calls].filter((id) => !results.has(id)),
  };
};

describe("compaction transcript integrity", () => {
  it("never orphans a tool result from its tool call, for any keepRecent", async () => {
    let compacted = 0;
    // Every keepRecent used to slice a raw count straight across tool rounds.
    for (let keepRecent = 2; keepRecent <= 10; keepRecent += 1) {
      const outcome = await compactMessages({
        model: {} as never,
        system: "s",
        messages: transcript(5),
        keepRecent,
        mode: "truncate",
      });
      // A tail that already covers everything leaves no middle; nothing to do.
      if (outcome === null) {
        continue;
      }
      compacted += 1;
      const { orphans, unanswered } = orphanIds(outcome.messages);
      expect(orphans, `keepRecent=${keepRecent} orphaned results`).toEqual([]);
      expect(unanswered, `keepRecent=${keepRecent} unanswered calls`).toEqual([]);
    }
    // Guards against the loop going vacuous.
    expect(compacted).toBeGreaterThan(0);
  });

  it("keeps the original task verbatim at the head", async () => {
    const outcome = await compactMessages({
      model: {} as never,
      system: "s",
      messages: transcript(5),
      keepRecent: 4,
      mode: "truncate",
    });
    expect(outcome!.messages[0]).toEqual({
      role: "user",
      content: "add a docs section",
    });
  });

  it("grows the tail backwards until it starts on a non-tool message", () => {
    // [user, c0, r0, c1, r1, c2, r2, c3, r3]
    const messages = transcript(4);
    expect(messages[messages.length - 3]?.role).toBe("tool");
    // keepRecent 3 lands on `r2`; the boundary must pull back to `c2`.
    expect(alignTailToToolBoundary(messages, 3)).toBe(5);
    // keepRecent 1 lands on `r3` -> pull back to `c3`.
    expect(alignTailToToolBoundary(messages, 1)).toBe(7);
    // keepRecent 8 already starts on an assistant message.
    expect(alignTailToToolBoundary(messages, 8)).toBe(1);
    // An over-long window clamps to the head.
    expect(alignTailToToolBoundary(messages, 50)).toBe(0);
  });

  it("returns null instead of compacting when there is no middle to summarize", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "done" },
    ];
    const outcome = await compactMessages({
      model: {} as never,
      system: "s",
      messages,
      keepRecent: 8,
      mode: "truncate",
    });
    expect(outcome).toBeNull();
  });
});
