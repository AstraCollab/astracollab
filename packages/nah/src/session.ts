import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import {
  createCodingTools,
  createJsonlSessionStore,
  runAgent,
  type HarnessEvent,
  type HarnessRunResult,
  type JsonlSessionStore,
  type SessionTaskLedger,
  type WorkspaceSnapshot,
} from "@astracollab/not-another-harness";
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";

import type { ResolvedModel } from "./model.js";
import type { PermissionMode } from "./permissions.js";
import { formatTaskLedger } from "./task-ledger.js";

/** Asks the user to approve a tool call and resolves with their answer. */
export type ApprovalPrompt = (question: string) => Promise<string>;

export type SessionState = {
  messages: ModelMessage[];
  system: string;
  cwd: string;
  tools: Record<string, unknown>;
  workspace: import("@astracollab/not-another-harness").ToolEnvironment;
  activeFileChanges: Array<{ path: string; existed: boolean; content?: string; after: string }> | null;
  activeShellCommands: string[] | null;
  undoHistory: Array<TurnRecovery>;
  sessionBasePath: string | null;
  taskLedger: SessionTaskLedger | null;
  discoveredChecks: string[];
  store: JsonlSessionStore | null;
  model: ResolvedModel | null;
  providerStatus: string | null;
  /** Cumulative usage across turns (for /stats). */
  totalUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Latest provider-reported input size, used as a current context estimate. */
  contextUsedTokens: number;
  contextUsageEstimated: boolean;
  /** Output tokens from the latest completed model step. */
  lastOutputTokens: number;
  turns: number;
  /** Approval policy for mutating tools (edit/write/bash). */
  permissions: PermissionMode;
  /**
   * Lets a host UI answer approval prompts itself. The alternate-screen TUI
   * must use this: the readline fallback cannot read stdin while the TUI owns
   * it in raw mode, and the unanswered prompt hangs the whole run.
   */
  setApprovalPrompt?: (prompt: ApprovalPrompt | null) => void;
  /** Display label for the working dir (e.g. remote sandbox name). */
  sandboxCwd?: string;
  /** Tear down a remote sandbox (no-op for local sessions). */
  destroySandbox?: () => Promise<void>;
  /** Cognitive Memory cache layer */
  cognitiveMemory?: import("@astracollab/not-another-harness").CognitiveMemory;
};

export type StepRecovery = {
  step: number;
  before: WorkspaceSnapshot | null;
  after: WorkspaceSnapshot | null;
  changedPaths: string[];
  beforeTouchedFingerprints: Record<string, string>;
  afterTouchedFingerprints: Record<string, string>;
  snapshotAvailable: boolean;
  snapshotReason?: string;
  fileChanges: Array<{ path: string; existed: boolean; content?: string; after: string }>;
  shellCommands: string[];
  messagesBefore: ModelMessage[];
  ledgerBefore: SessionTaskLedger | null;
};

export type TurnRecovery = {
  steps: StepRecovery[];
  changes: Array<{ path: string; existed: boolean; content?: string; after: string }>;
  messages: ModelMessage[];
  ledgerBefore: SessionTaskLedger | null;
};

type ActiveStepSnapshot = {
  step: number;
  before: WorkspaceSnapshot | null;
  fileChangeOffset: number;
  messagesBefore: ModelMessage[];
  ledgerBefore: SessionTaskLedger | null;
  shellCommands: string[];
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
 * `done` resolves with the turn result either way. `steer`/`followUp` let the
 * user send input while the turn is still in flight; both land at the next step
 * boundary rather than cutting off the model call that is currently streaming.
 */
export const runTurn = (
  state: SessionState,
  prompt: string,
  hooks: TurnHooks = {},
): {
  events: AsyncIterable<HarnessEvent>;
  done: Promise<HarnessRunResult>;
  steer: (text: string) => boolean;
  followUp: (text: string) => boolean;
  pending: () => { steer: readonly string[]; followUp: readonly string[] };
} => {
  if (!state.model) {
    throw new Error("No model is configured. Set a provider API key, then choose a model with /model <provider:model-id>.");
  }
  const before = state.messages.length;
  const previousMessages = [...state.messages];
  const ledgerBefore = state.taskLedger ? structuredClone(state.taskLedger) : null;
  const fileChanges: Array<{ path: string; existed: boolean; content?: string; after: string }> = [];
  const stepRecoveries: StepRecovery[] = [];
  const previouslyTouchedPaths = new Set<string>();
  let activeStep: ActiveStepSnapshot | null = null;
  state.activeFileChanges = fileChanges;
  state.activeShellCommands = null;
  const taskContext = [
    "Task tracking: For substantial multi-step work, call task_ledger discover_checks before editing. Save a plan using exact discovered executable acceptance commands. Update progress as you work, run each check through task_ledger run_check, repair failures and rerun, and mark completed only when all steps are complete and every check has an actual zero exit code. The task_ledger tool result is the latest source of task status during this run.",
    state.tools.delegate_task
      ? "Delegation: Use delegate_task only for independent, bounded subtasks that can start from committed HEAD and do not depend on uncommitted parent changes. The child runs in a temporary isolated worktree; inspect its returned diff and integrate changes deliberately. Delegated changes are not merged automatically. Do not delegate subtasks that depend on each other."
      : "",
    state.taskLedger && state.taskLedger.status !== "completed"
      ? `Current durable task ledger:\n${formatTaskLedger(state.taskLedger)}`
      : "",
    state.cognitiveMemory ? state.cognitiveMemory.getPromptContext(prompt) : "",
  ].filter(Boolean).join("\n\n");
  const run = runAgent({
    model: state.model.model,
    system: `${state.system}\n\n${taskContext}`,
    prompt,
    messages: state.messages,
    tools: state.tools,
    abortSignal: hooks.signal,
    onStepStart: async (step, messages) => {
      let before: WorkspaceSnapshot | null = null;
      try {
        before = state.workspace.snapshot && state.workspace.restoreSnapshot
          ? await state.workspace.snapshot()
          : null;
      } catch { before = null; }
      const startedStep: ActiveStepSnapshot = {
        step,
        before,
        fileChangeOffset: fileChanges.length,
        messagesBefore: messages,
        ledgerBefore: state.taskLedger ? structuredClone(state.taskLedger) : null,
        shellCommands: [],
      };
      activeStep = startedStep;
      state.activeShellCommands = startedStep.shellCommands;
    },
    onStepFinish: async (_step, _messages) => {
      const finishedStep = activeStep;
      if (!finishedStep) return;
      let after: WorkspaceSnapshot | null = null;
      try {
        after = state.workspace.snapshot && state.workspace.restoreSnapshot
          ? await state.workspace.snapshot()
          : null;
      } catch { after = null; }
      const recovery = makeStepRecovery(finishedStep, after, fileChanges.slice(finishedStep.fileChangeOffset), previouslyTouchedPaths);
      stepRecoveries.push(recovery);
      recovery.changedPaths.forEach((path) => previouslyTouchedPaths.add(path));
      if (activeStep === finishedStep) {
        activeStep = null;
        state.activeShellCommands = null;
      }
    },
  });

  const done = (async () => {
    let result: HarnessRunResult;
    try {
      result = await run.result;
    } finally {
      const unfinishedStep = activeStep as ActiveStepSnapshot | null;
      if (unfinishedStep) {
        let after: WorkspaceSnapshot | null = null;
        try {
          after = state.workspace.snapshot && state.workspace.restoreSnapshot
            ? await state.workspace.snapshot()
            : null;
        } catch { after = null; }
        const recovery = makeStepRecovery(unfinishedStep, after, fileChanges.slice(unfinishedStep.fileChangeOffset), previouslyTouchedPaths);
        stepRecoveries.push(recovery);
        recovery.changedPaths.forEach((path) => previouslyTouchedPaths.add(path));
      }
      activeStep = null;
      state.activeFileChanges = null;
      state.activeShellCommands = null;
      state.undoHistory.push({ steps: stepRecoveries, changes: fileChanges, messages: previousMessages, ledgerBefore });
    }
    state.messages = [...result.messages];
    state.turns += 1;
    state.totalUsage.inputTokens += result.usage.inputTokens;
    state.totalUsage.outputTokens += result.usage.outputTokens;
    state.totalUsage.totalTokens += result.usage.totalTokens;
    if (state.store) {
      if (result.compactions > 0 || result.messages.length < before) {
        await state.store.replace(result.messages);
      } else {
        await state.store.append(result.messages.slice(before));
      }
    }
    // Fire CognitiveMemory post-turn async evaluation without blocking
    if (state.cognitiveMemory) {
      const assistantText = result.messages
        .filter((m) => m.role === "assistant")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      void state.cognitiveMemory.postTurnAsync({
        userMessage: prompt,
        assistantResponse: assistantText,
      }).catch(() => undefined);
    }
    return result;
  })();

  const events = (async function* () {
    for await (const event of run.events) {
      hooks.onEvent?.(event);
      yield event;
    }
  })();
  return { events, done, steer: run.steer, followUp: run.followUp, pending: run.pending };
};

const makeStepRecovery = (
  active: ActiveStepSnapshot,
  after: WorkspaceSnapshot | null,
  fileChanges: StepRecovery["fileChanges"],
  previouslyTouchedPaths: Set<string>,
): StepRecovery => {
  const before = active.before;
  const snapshotAvailable = before?.complete === true && after?.complete === true;
  const changedPaths = snapshotAvailable
    ? [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].filter((path) => JSON.stringify(before.entries[path]) !== JSON.stringify(after.entries[path]))
    : [];
  const trackedPaths = new Set([...previouslyTouchedPaths, ...changedPaths]);
  const fingerprints = (snapshot: WorkspaceSnapshot | null): Record<string, string> => {
    if (!snapshot || !snapshotAvailable) return {};
    return Object.fromEntries([...trackedPaths].map((path) => [path, snapshot.entries[path]
      ? createHash("sha256").update(JSON.stringify(snapshot.entries[path])).digest("hex")
      : "missing"]));
  };
  const retainEntries = (snapshot: WorkspaceSnapshot | null): WorkspaceSnapshot | null => {
    if (!snapshot || !snapshotAvailable) return null;
    const entries: WorkspaceSnapshot["entries"] = {};
    for (const path of changedPaths) {
      const entry = snapshot.entries[path];
      if (entry) entries[path] = entry;
    }
    return { ...snapshot, entries };
  };
  return {
    step: active.step,
    before: retainEntries(before),
    after: retainEntries(after),
    changedPaths,
    beforeTouchedFingerprints: fingerprints(before),
    afterTouchedFingerprints: fingerprints(after),
    snapshotAvailable,
    ...(!snapshotAvailable ? { snapshotReason: before?.reason ?? after?.reason ?? "workspace does not support complete snapshots" } : {}),
    fileChanges,
    shellCommands: [...active.shellCommands],
    messagesBefore: active.messagesBefore,
    ledgerBefore: active.ledgerBefore,
  };
};

/** Load prior messages into the session (for --continue / --session). */
export const resumeSession = async (state: SessionState): Promise<boolean> => {
  if (!state.store) {
    return false;
  }
  state.messages = await state.store.load();
  state.taskLedger = await state.store.loadTaskLedger();
  return state.messages.length > 0;
};
