import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import type { ModelMessage } from "ai";
import { detectMemoryTriggers } from "./memory-injection.js";
import {
  createCodingTools,
  createJsonlSessionStore,
  runAgent,
  type HarnessEvent,
  type HarnessRunResult,
  type JsonlSessionStore,
  type MemoryInjectionReport,
  type SessionTaskLedger,
  type WorkspaceSnapshot,
} from "@astracollab/not-another-harness";
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";

import type { ResolvedModel } from "./model.js";
import type { PermissionMode } from "./permissions.js";
import { formatTaskLedger } from "./task-ledger.js";
import { ratesFor } from "./rates.js";
import { resolveTurnSpendUsd } from "./budget.js";

/**
 * Per-request ceiling for one interactive turn, checked against the model's
 * context window. Generous on purpose: exceeding the window is fixable, so this
 * should compact rather than stop, and compaction is only worth doing when the
 * request is genuinely large.
 */
const TURN_CONTEXT_LIMIT = 180_000;

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
  /** Cumulative prompt-cache read tokens across the session. */
  cacheReadTokens: number;
  /** Cumulative prompt-cache write tokens across the session. */
  cacheWriteTokens: number;
  /**
   * Cache hit rate of the most recent request, 0..1.
   *
   * The one number that says whether caching is working. A run that reads its
   * prefix back pays ~0.1x per token; one that rewrites it every step pays 1.25x.
   * Above ~0.9 is healthy, and a persistent low value means something in the
   * prefix is changing between steps.
   */
  cacheHitRate: number;
  /** Cumulative spend this session in USD, or 0 when rates are unknown. */
  spendUsd: number;
  /**
   * Explicit per-turn spend override in USD, or null to use the context-scaled
   * default. Set by `/budget`.
   */
  /**
   * Explicit per-turn spend ceiling in USD, or null for none.
   *
   * Null is the normal state, and it means the turn runs until the task is done,
   * the context window is full, or the human interrupts. See `budget.ts` for why
   * nothing is picked automatically.
   */
  turnSpendLimitUsd: number | null;
  /**
   * Explicit per-turn step ceiling, or null for none.
   *
   * Null is the normal state and matches the harness default: a turn runs until
   * the model says it is done, the window fills, or a human interrupts. Set one
   * only if you want an unattended run bounded — nothing here picks a number.
   */
  turnStepLimit: number | null;
  /** Approval policy for mutating tools (edit/write/bash). */
  permissions: PermissionMode;
  /**
   * Lets a host UI answer approval prompts itself. The alternate-screen TUI
   * must use this: the readline fallback cannot read stdin while the TUI owns
   * it in raw mode, and the unanswered prompt hangs the whole run.
   */
  setApprovalPrompt?: (prompt: ApprovalPrompt | null) => void;
  /** Rolling record of what memory injected into each turn's prompt. */
  memoryInjectionLog?: import("./memory-injection.js").MemoryInjectionLog;
  /**
   * Called after the active session is replaced. The TUI uses it to rebuild the
   * transcript pane, which is otherwise only seeded once at startup.
   */
  onSessionSwitch?: (messages: ModelMessage[]) => void;
  /** Display label for the working dir (e.g. remote sandbox name). */
  sandboxCwd?: string;
  /**
   * Directory the file tools are confined to. Normally the enclosing git
   * repository rather than `cwd`, so a monorepo package is not a pen.
   */
  workspaceRoot?: string;
  /** Tear down a remote sandbox (no-op for local sessions). */
  destroySandbox?: () => Promise<void>;
  /**
   * The memory backend for this session.
   *
   * Either the in-process engine over SQLite or the hosted service, behind
   * `SessionMemory` — the field name is the concept, not the class. Swapping it
   * is what `/cogmem` does, and the recall tool reads it through a getter so it
   * follows the swap.
   */
  cognitiveMemory?: import("./memory-backend.js").SessionMemory;
  /**
   * Why memory is not what the config asked for, printed once at startup.
   *
   * Set when hosted memory is enabled but unreachable, or when it is in use. A
   * silent fallback looks exactly like working memory until a fact fails to
   * survive a restart.
   */
  memoryNote?: string;
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
 * Split a turn's context into the part that is cached and the part that is not.
 *
 * The system prompt is the first thing in every request and the anchor for prefix
 * caching, so a single changed byte in it invalidates the *entire* cached prefix:
 * system, tool schemas, and the whole transcript behind them. The whole request is
 * then re-read at full price, which for a cached token is roughly 10x what the
 * same request costs when the prefix hits.
 *
 * The task ledger and the memory injection both used to live here. Both change
 * from turn to turn, so every turn whose ledger or injection differed from the
 * last one started cold. Measured on a real session: turns that left the ledger
 * alone hit 87-96% cache, and one turn billed 599,127 input tokens to read 288 of
 * them back — 0.05%. Nothing about that turn was unusual except that it touched
 * the task ledger.
 *
 * They are state, not instructions, so the tail is where they belong anyway. The
 * model reads a current plan better as the most recent thing in the conversation
 * than as a system-level assertion written once at the start, and the cost of them
 * changing drops from re-reading the whole transcript to one new message.
 *
 * Returned rather than inlined so the invariant is directly testable: the system
 * half must be byte-identical across turns no matter what the ledger does.
 */
export const composeTurnRequest = (
  state: Pick<SessionState, "system" | "tools" | "taskLedger">,
  prompt: string,
  injectionText: string,
): { system: string; prompt: string } => {
  const staticContext = [
    "Task tracking: For substantial multi-step work, call task_ledger discover_checks before editing. Save a plan using exact discovered executable acceptance commands. Update progress as you work, run each check through task_ledger run_check, repair failures and rerun, and mark completed only when all steps are complete and every check has an actual zero exit code. The task_ledger tool result is the latest source of task status during this run.",
    state.tools.delegate_task
      ? "Delegation: Use delegate_task only for independent, bounded subtasks that can start from committed HEAD and do not depend on uncommitted parent changes. The child runs in a temporary isolated worktree; inspect its returned diff and integrate changes deliberately. Delegated changes are not merged automatically. Do not delegate subtasks that depend on each other."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const dynamicContext = [
    state.taskLedger && state.taskLedger.status !== "completed"
      ? `Current durable task ledger:\n${formatTaskLedger(state.taskLedger)}`
      : "",
    injectionText,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    system: staticContext ? `${state.system}\n\n${staticContext}` : state.system,
    // The user's ask stays last, so the harness-generated preamble reads as
    // context for it rather than a substitute for it.
    prompt: dynamicContext ? `${dynamicContext}\n\n---\n\n${prompt}` : prompt,
  };
};

/** The prompt block for one turn, and the report `/memory` logs it from. */
export type ResolvedInjection = {
  text: string;
  report: MemoryInjectionReport;
};

const NO_INJECTION: ResolvedInjection = {
  text: "",
  report: { text: "", entries: [], totalTokens: 0, truncated: false },
};

/**
 * Ask the backend what this turn should be told, before the request is built.
 *
 * Split out of `runTurn` because that function is synchronous and returns a
 * handle, and the hosted backend cannot answer without a round trip. The
 * alternative — making `runTurn` async — would push a memory failure into every
 * caller, including the ones that never touch memory, so the wait lives where
 * the decision does.
 *
 * Contained for the same reason the adapters contain their own failures: a
 * backend that throws here would otherwise take down a turn before the model was
 * ever called, and an empty prompt is a worse turn rather than a failed one.
 */
export const resolveInjection = async (
  state: Pick<SessionState, "cognitiveMemory" | "memoryInjectionLog" | "messages">,
  prompt: string,
): Promise<ResolvedInjection> => {
  const memory = state.cognitiveMemory;
  if (!memory) return NO_INJECTION;
  try {
    const forced = await detectMemoryTriggers(memory, prompt, state.messages);
    const report = await memory.planInjection({ userMessage: prompt, forceFull: forced });
    state.memoryInjectionLog?.record(report);
    return { text: report.text, report };
  } catch (error) {
    if (process.env.NAH_MEMORY_DEBUG === "1") {
      console.log(`  [memory] injection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return NO_INJECTION;
  }
};

/**
 * A stable id for this conversation, so the service can group what it learns.
 *
 * Derived from the session file rather than generated, because resuming a session
 * should not look like a second conversation to the service — the memories
 * belong to the same thread of work.
 */
const sessionIdFor = (state: Pick<SessionState, "store" | "sessionBasePath">): string => {
  const path = state.store?.path ?? state.sessionBasePath;
  const stem = path ? nodePath.basename(path).replace(/\.jsonl$/, "") : "";
  return stem ? `nah-${stem}` : `nah-${process.pid}`;
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
  injection?: ResolvedInjection,
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
  // Memory injection is decided here, not by the model: an identifier the user
  // named that is absent from the transcript earns its memory's full body, and
  // everything else appears as a one-line index entry. Awaited by the caller and
  // handed in, because the hosted backend has to ask a server before the
  // request can be composed — see `resolveInjection`.
  const injectionText = injection?.text ?? "";

  const { system, prompt: requestPrompt } = composeTurnRequest(state, prompt, injectionText);

  const run = runAgent({
    model: state.model.model,
    // Enables Anthropic-style prompt-cache breakpoints. Safe and worthwhile
    // because it only *marks* the prefix; nothing is rewritten, so thinking
    // signatures stay valid.
    cacheProvider: state.model.provider,
    // 1h, not 5m. The cache lifetime runs from the *start* of the request that
    // writes or reads it, so a step that spends four minutes streaming burns four
    // minutes of a five-minute window and the next request starts cold. Long
    // agent steps are exactly the case 5m is wrong for; 1h writes cost 2x
    // instead of 1.25x and break even after two reads.
    cacheTtl: "1h",
    // Let the API clear old tool results for us. Triggers well below our own
    // compaction threshold, because the cost is the repeated replay of a
    // transcript that never grows large enough to trip that threshold.
    // Provider-agnostic transcript bounding. No-op when reasoning is present,
    // so Anthropic still prefers server-side editing, which is safer there.
    pruneToolResults: { keepRecentToolCalls: 6 },
    contextEditing: {
      triggerTokens: 40_000,
      keepToolUses: 6,
      excludeTools: ["read", "edit", "write"],
    },
    // Money, not tokens. A cached token costs a tenth of a fresh one, so a token
    // count charges a well-cached run at ~10x its real cost and fires on harness
    // efficiency rather than on money spent.
    rates: ratesFor(state.model.modelId),
    // No ceiling unless the user asked for one. `0` is the harness's "no budget",
    // and it is the default because a turn that stops mid-task for money the user
    // never agreed to spend is worse than one that runs long.
    maxSpendUsd: resolveTurnSpendUsd(state.turnSpendLimitUsd),
    // Unbounded unless the user asked for a ceiling. See `turnStepLimit`.
    ...(state.turnStepLimit === null ? {} : { maxSteps: state.turnStepLimit }),
    // The model's window. Exceeding it is fixable — compaction shrinks the
    // request — so this triggers compaction, and only stops a run when even a
    // compacted request cannot fit.
    maxContextTokens: TURN_CONTEXT_LIMIT,
    system,
    prompt: requestPrompt,
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
    foldTurnIntoState(state, result);
    if (state.store) {
      if (result.compactions > 0 || result.messages.length < before) {
        await state.store.replace(result.messages);
      } else {
        await state.store.append(result.messages.slice(before));
      }
    }
    // Written after the transcript so a crash between the two leaves counters
    // that are behind the messages, never ahead of them.
    await saveUsage(state);
    // Fire CognitiveMemory post-turn async evaluation without blocking
    if (state.cognitiveMemory) {
      const assistantText = result.messages
        .filter((m) => m.role === "assistant")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      void state.cognitiveMemory.postTurnAsync({
        userMessage: prompt,
        assistantResponse: assistantText,
        sessionId: sessionIdFor(state),
      }).catch(() => undefined);
    }
    return result;
  })();

  /**
   * Captured before the turn runs, not read per event: awaiting inside the
   * event loop lets the turn settle underneath it, so `state.turns` had already
   * advanced and every record after the first was stamped with the next turn.
   */
  const turnNumber = state.turns + 1;

  const events = (async function* () {
    for await (const event of run.events) {
      /**
       * Per-step accounting, written as it happens.
       *
       * End-of-turn totals cannot explain a surprising number: a turn reporting
       * 553k processed may have been 27 requests replaying a transcript, with
       * the largest single request only 36.6k. Keeping each step's request size
       * and cache composition on disk is what makes that answerable later,
       * rather than by reconstructing it from the transcript by hand.
       */
      if (event.type === "step-finish" && state.store) {
        try {
          await state.store.appendStepUsage({
            turn: turnNumber,
            step: event.step,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            totalTokens: event.usage.totalTokens,
            requestTokens: event.request?.totalInputTokens ?? 0,
            freshInputTokens: event.request?.freshInputTokens ?? 0,
            cachedInputTokens: event.request?.cachedInputTokens ?? 0,
            cacheCreationInputTokens: event.request?.cacheCreationInputTokens ?? 0,
            hitRate: event.request?.hitRate ?? 0,
            estimated: event.usage.estimated === true,
          });
        } catch {
          // Accounting must never fail a turn.
        }
      }
      hooks.onEvent?.(event);
      yield event;
    }
  })();
  return { events, done, steer: run.steer, followUp: run.followUp, pending: run.pending };
};

/**
 * Point the in-memory counters at whatever session is now active.
 *
 * Called after `/session` and `/branch` swap `state.store`. The alternative —
 * leaving the counters alone — makes `/stats` and the prompt footer report the
 * session you just navigated away from, against the transcript you are now
 * looking at.
 */
export const adoptUsage = async (state: SessionState): Promise<void> => {
  const usage = (await state.store?.loadUsage()) ?? null;
  if (!usage) {
    await resetUsage(state);
    return;
  }
  state.turns = usage.turns;
  state.totalUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
  state.contextUsedTokens = usage.contextUsedTokens;
  state.contextUsageEstimated = usage.contextUsageEstimated;
  state.lastOutputTokens = usage.lastOutputTokens;
  state.cacheReadTokens = usage.cacheReadTokens ?? 0;
  state.cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  state.spendUsd = usage.spendUsd ?? 0;
};

/** Reset the cumulative counters and push the zeroed state to the store. */
export const resetUsage = async (state: SessionState): Promise<void> => {
  state.turns = 0;
  state.totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  state.contextUsedTokens = 0;
  state.contextUsageEstimated = false;
  state.lastOutputTokens = 0;
  state.cacheReadTokens = 0;
  state.cacheWriteTokens = 0;
  state.cacheHitRate = 0;
  state.spendUsd = 0;
  await saveUsage(state);
};

/** Write the current counters so a later process can resume reporting them. */
export const saveUsage = async (state: SessionState): Promise<void> => {
  if (!state.store) return;
  try {
    await state.store.saveUsage({
      turns: state.turns,
      inputTokens: state.totalUsage.inputTokens,
      outputTokens: state.totalUsage.outputTokens,
      totalTokens: state.totalUsage.totalTokens,
      contextUsedTokens: state.contextUsedTokens,
      contextUsageEstimated: state.contextUsageEstimated,
      lastOutputTokens: state.lastOutputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheWriteTokens: state.cacheWriteTokens,
      spendUsd: state.spendUsd,
    });
  } catch {
    // Stats are cosmetic next to the transcript, which is already saved. A
    // failure here must not fail the turn.
  }
};

const foldTurnIntoState = (state: SessionState, result: HarnessRunResult): void => {
  state.turns += 1;
  state.totalUsage.inputTokens += result.usage.inputTokens;
  state.totalUsage.outputTokens += result.usage.outputTokens;
  state.totalUsage.totalTokens += result.usage.totalTokens;
  state.cacheReadTokens += result.usage.cachedInputTokens ?? 0;
  state.cacheWriteTokens += result.usage.cacheCreationInputTokens ?? 0;
  state.spendUsd += result.usage.spendUsd ?? 0;
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

/**
 * Load prior messages and counters into the session (for --continue / --session).
 *
 * Both halves matter. The messages are the transcript the model continues from;
 * the counters are what `/stats` and the prompt footer report. Loading only the
 * messages made a resumed session print `0 turns · 0 in · 0 out` next to a
 * 34-message transcript, which reads as a broken restore rather than a fresh
 * one.
 */
export const resumeSession = async (state: SessionState): Promise<boolean> => {
  if (!state.store) {
    return false;
  }
  state.messages = await state.store.load();
  state.taskLedger = await state.store.loadTaskLedger();
  const usage = await state.store.loadUsage();
  state.turns = usage.turns;
  state.totalUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
  state.contextUsedTokens = usage.contextUsedTokens;
  state.contextUsageEstimated = usage.contextUsageEstimated;
  state.lastOutputTokens = usage.lastOutputTokens;
  state.cacheReadTokens = usage.cacheReadTokens ?? 0;
  state.cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  state.spendUsd = usage.spendUsd ?? 0;
  return state.messages.length > 0;
};
