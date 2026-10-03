/**
 * Deterministic memory triggering and injection logging.
 *
 * Two jobs, both mechanical so they do not depend on the model cooperating:
 *
 * 1. **Trigger detection.** Aider's repo map pulls identifiers out of the user's
 *    message and uses them to boost matching code (its `mentioned_idents`). We do
 *    the same against memory: if the user names something concrete that is *not*
 *    in the visible transcript, any memory mentioning it earns a full body in the
 *    prompt — no model decision required.
 * 2. **Logging what went in.** There is no published benchmark of pre-inject vs
 *    on-demand for coding-agent project memory, so the only way to tune the
 *    tradeoff is to see it. Every injection is recorded with a reason.
 */
import type { ModelMessage } from "ai";
import {
  extractIdentifiers,
  type MemoryInjectionReport,
} from "not-another-harness";

import type { SessionMemory } from "./memory-backend.js";

/** Flatten a transcript into one lowercased blob for "have we already seen this". */
const transcriptText = (messages: readonly ModelMessage[]): string =>
  messages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (!Array.isArray(m.content)) return "";
      return m.content
        .map((p) => ("text" in p ? String(p.text ?? "") : ""))
        .join(" ");
    })
    .join("\n")
    .toLowerCase();

/**
 * Memory ids whose body should be forced into the prompt.
 *
 * Only identifiers absent from the transcript qualify: if the user is already
 * repeating something visible, the model has it and spending tokens on it is
 * waste.
 *
 * Async because `search` is: the local engine ranks in-process, and the hosted
 * backend asks a service. Callers are on the pre-request path and already await
 * one memory call, so this adds no new wait that was not there.
 */
export const detectMemoryTriggers = async (
  memory: SessionMemory | undefined,
  userMessage: string,
  transcript: readonly ModelMessage[],
): Promise<string[]> => {
  if (!memory) return [];
  const seen = transcriptText(transcript);
  const unseen = extractIdentifiers(userMessage).filter((id) => !seen.includes(id.toLowerCase()));
  if (unseen.length === 0) return [];

  const forced: string[] = [];
  for (const { item } of await memory.search(unseen.join(" "), 12)) {
    const haystack = item.content.toLowerCase();
    if (unseen.some((id) => haystack.includes(id.toLowerCase()))) {
      forced.push(item.id);
    }
  }
  return forced;
};

export type InjectionLogEntry = {
  turn: number;
  totalTokens: number;
  truncated: boolean;
  items: Array<{ id: string; reason: string; tier: string; gist: string; hasBody: boolean; tokens: number }>;
};

const MAX_LOGGED_TURNS = 20;

/** Rolling record of what memory put into each turn's prompt. */
export class MemoryInjectionLog {
  private readonly turns: InjectionLogEntry[] = [];
  private turn = 0;

  /** Call once per turn, before the model runs. */
  record(report: MemoryInjectionReport): void {
    this.turn += 1;
    this.turns.push({
      turn: this.turn,
      totalTokens: report.totalTokens,
      truncated: report.truncated,
      items: report.entries.map((entry) => ({
        id: entry.id,
        reason: entry.reason,
        tier: entry.tier,
        gist: entry.gist,
        hasBody: entry.body !== undefined,
        tokens: entry.tokens,
      })),
    });
    if (this.turns.length > MAX_LOGGED_TURNS) this.turns.shift();
  }

  get entries(): readonly InjectionLogEntry[] {
    return this.turns;
  }

  /** Aggregate view, for `/memory` and for tuning the budget. */
  summary(): {
    turns: number;
    avgTokens: number;
    maxTokens: number;
    byReason: Record<string, number>;
    truncatedTurns: number;
  } {
    const byReason: Record<string, number> = {};
    let total = 0;
    let max = 0;
    let truncatedTurns = 0;
    for (const turn of this.turns) {
      total += turn.totalTokens;
      max = Math.max(max, turn.totalTokens);
      if (turn.truncated) truncatedTurns += 1;
      for (const item of turn.items) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
    }
    return {
      turns: this.turns.length,
      avgTokens: this.turns.length > 0 ? Math.round(total / this.turns.length) : 0,
      maxTokens: max,
      byReason,
      truncatedTurns,
    };
  }
}
