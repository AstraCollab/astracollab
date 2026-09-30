import type { ModelMessage } from "ai";
import {
  createCodingTools,
  createJsonlSessionStore,
  runAgent,
  type HarnessEvent,
  type HarnessRunResult,
  type JsonlSessionStore,
} from "@astracollab/not-another-harness";
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";

import type { ResolvedModel } from "./model.js";
import type { PermissionMode } from "./permissions.js";

export type SessionState = {
  messages: ModelMessage[];
  system: string;
  cwd: string;
  tools: Record<string, unknown>;
  store: JsonlSessionStore | null;
  model: ResolvedModel;
  /** Cumulative usage across turns (for /stats). */
  totalUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  turns: number;
  /** Approval policy for mutating tools (edit/write/bash). */
  permissions: PermissionMode;
  /** Display label for the working dir (e.g. remote sandbox name). */
  sandboxCwd?: string;
  /** Tear down a remote sandbox (no-op for local sessions). */
  destroySandbox?: () => Promise<void>;
};

export type TurnHooks = {
  onEvent?: (event: HarnessEvent) => void;
  signal?: AbortSignal;
};

/**
 * Run one agent turn on top of the session's current messages, then fold the
 * transcript back into state and persist the delta (Pi-style branch append).
 *
 * The caller consumes `events` (unbounded queue — consumption is optional);
 * `done` resolves with the turn result either way.
 */
export const runTurn = (
  state: SessionState,
  prompt: string,
  hooks: TurnHooks = {},
): { events: AsyncIterable<HarnessEvent>; done: Promise<HarnessRunResult> } => {
  const before = state.messages.length;
  const run = runAgent({
    model: state.model.model,
    system: state.system,
    prompt,
    messages: state.messages,
    tools: state.tools,
    abortSignal: hooks.signal,
  });

  const done = (async () => {
    const result = await run.result;
    const delta = result.messages.slice(before);
    state.messages = [...result.messages];
    state.turns += 1;
    state.totalUsage.inputTokens += result.usage.inputTokens;
    state.totalUsage.outputTokens += result.usage.outputTokens;
    state.totalUsage.totalTokens += result.usage.totalTokens;
    if (state.store) {
      await state.store.append(delta).catch(() => undefined);
    }
    return result;
  })();

  return { events: run.events, done };
};

/** Load prior messages into the session (for --continue / --session). */
export const resumeSession = async (state: SessionState): Promise<boolean> => {
  if (!state.store) {
    return false;
  }
  state.messages = await state.store.load();
  return state.messages.length > 0;
};
