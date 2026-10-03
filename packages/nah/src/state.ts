/**
 * Building a session's state.
 *
 * Separate from the REPL because three callers need it and only one of them is a
 * REPL: the TUI, the line renderer, and the read-only agent the Studio drives
 * from a browser. The last one is the reason this file imports nothing from
 * `tui/` — the Studio is a server, and pulling a terminal UI in to ask it for a
 * system prompt would be an odd thing to ship.
 */

import { buildNahSystemPrompt } from "./context.js";
import { resolveModel } from "./model.js";
import { loadLastModel } from "./model-preferences.js";
import { selectMemory } from "./memory-select.js";
import { createRecallTool, createRememberTool } from "./memory-tool.js";
import { MemoryInjectionLog } from "./memory-injection.js";
import { createApprover, type PermissionMode } from "./permissions.js";
import type { SessionState } from "./session.js";
import { createTaskLedgerTool } from "./task-ledger.js";
import { createDelegationTools, createSessionOrchestrator } from "./delegation.js";
import { createWorkflowTools } from "./workflow-tools.js";
import { loadWorkspaceWorkflows } from "./workspace-workflows.js";
import { createNahWorkflows } from "./workflows.js";
import { connectStudio } from "./telemetry-export.js";
import { describeWorkspaceBoundary, resolveWorkspaceRoot } from "./workspace.js";

export const makeState = async (opts: {
  cwd: string;
  modelSpec?: string;
  sessionPath?: string;
  noSession?: boolean;
  permissions?: PermissionMode;
  /** Blaxel sandbox name, or true to create an ephemeral one. */
  sandbox?: string | true;
  extraSystemAppend?: string;
  allowUnconfiguredModel?: boolean;
  /**
   * Report this session's turns to a running Studio. Default true.
   *
   * `false` for the Studio's own agent: it saves its traces directly, and a
   * session that also pushed them over HTTP would record every run twice.
   */
  telemetry?: boolean;
}): Promise<SessionState> => {
  let model: SessionState["model"];
  try {
    const savedModel = opts.modelSpec === undefined && process.env.NAH_MODEL === undefined
      ? await loadLastModel()
      : undefined;
    model = await resolveModel(opts.modelSpec ?? savedModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.allowUnconfiguredModel && /credentials are not set|API_KEY is not set|needs NAH_API_KEY/.test(message)) {
      model = null;
    } else {
      throw error;
    }
  }
  // Memory: model-backed extraction plus on-disk persistence, so what a turn
  // teaches survives into the next session. Extraction uses the same model.
  const selection = await selectMemory({
    cwd: opts.cwd,
    persist: !opts.noSession,
    model: model ? model.model : null,
  });

  const { createCodingTools, createJsonlSessionStore } = await import(
    "not-another-harness"
  );

  let envToolSource: Parameters<typeof createCodingTools>[0];
  let cwdLabel = opts.cwd;
  let destroySandbox: (() => Promise<void>) | undefined;
  /**
   * The directory the file tools are confined to. Normally the enclosing git
   * repository rather than `opts.cwd`, because `cwd` is where the user happened to
   * be standing while the unit of work is usually the repo. See workspace.ts for
   * the measured cost of getting this wrong.
   */
  let workspaceRoot = opts.cwd;
  if (opts.sandbox) {
    const { createBlaxelEnvironment } = await import("./sandbox.js");
    const bl = await createBlaxelEnvironment({
      sandboxName: opts.sandbox === true ? undefined : opts.sandbox,
    });
    envToolSource = bl.env;
    cwdLabel = `blaxel sandbox ${bl.sandboxName}`;
    destroySandbox = bl.destroy;
  } else {
    const { createNodeEnvironment } = await import("not-another-harness/node");
    workspaceRoot = await resolveWorkspaceRoot(opts.cwd);
    envToolSource = createNodeEnvironment(workspaceRoot);
  }

  const system =
    opts.sandbox != null
      ? [
          await buildSystemPromptFor(opts.cwd, cwdLabel),
          "",
          `You are working in a remote sandbox (repo at ${cwdLabel === opts.cwd ? opts.cwd : "/workspace/repo"}). Changes do not affect the local machine.`,
        ].join("\n")
      : [
          await buildNahSystemPrompt(opts.cwd),
          describeWorkspaceBoundary(workspaceRoot, opts.cwd),
        ].join("\n\n");

  const store = opts.noSession || !opts.sessionPath ? null : createJsonlSessionStore(opts.sessionPath);
  const taskLedger = await store?.loadTaskLedger() ?? null;
  const state: SessionState = {
    messages: [],
    system,
    cwd: opts.cwd,
    tools: {},
    workspace: envToolSource,
    activeFileChanges: null,
    activeShellCommands: null,
    undoHistory: [],
    sessionBasePath: opts.noSession ? null : opts.sessionPath ?? null,
    taskLedger,
    discoveredChecks: [],
    store,
    model,
    providerStatus: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextUsedTokens: 0,
    contextUsageEstimated: false,
    lastOutputTokens: 0,
    turns: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: 0,
    spendUsd: 0,
    // Null means "use the context-scaled default", which is the point: a turn
    // should not inherit a ceiling sized for a different amount of context.
    turnSpendLimitUsd: null,
    turnStepLimit: null,
    permissions: opts.permissions ?? "yolo",
    sandboxCwd: cwdLabel,
    workspaceRoot: opts.sandbox == null ? workspaceRoot : undefined,
    destroySandbox,
    cognitiveMemory: selection.memory,
    ...(selection.note === undefined ? {} : { memoryNote: selection.note }),
    memoryInjectionLog: new MemoryInjectionLog(),
    studio:
      opts.telemetry === false
        ? null
        : await connectStudio({ cwd: opts.cwd, model: model?.spec ?? null }),
  };
  model?.setStatusHandler((status) => { state.providerStatus = status; });
  const approve = createApprover(() => state.permissions);
  state.setApprovalPrompt = (prompt) => approve.setPrompt(prompt);
  // One orchestrator for the whole session, shared by direct delegation and by
  // workflows: two of them would mean two concurrency pools and two spend counters,
  // so the children a session actually ran would be twice what it reported. Absent
  // in a sandbox, where there is no local workspace for a worktree to come from.
  const orchestrator = opts.sandbox
    ? undefined
    : createSessionOrchestrator({
        cwd: opts.cwd,
        system: state.system,
        getModel: () => {
          if (!state.model) throw new Error("Configure a model before delegating a task.");
          return state.model.model;
        },
        approve,
        onChildUsage: (usage) => {
          state.totalUsage.inputTokens += usage.inputTokens;
          state.totalUsage.outputTokens += usage.outputTokens;
          state.totalUsage.totalTokens += usage.totalTokens;
        },
      });
  state.orchestrator = orchestrator;
  state.workflows = orchestrator ? createNahWorkflows({ cwd: opts.cwd }) : undefined;
  // Loaded here so `/workflow` lists what the workspace has on disk from the
  // first keystroke, and quietly skipped when one is broken: `/workspace` is
  // where a file that will not load gets named.
  if (state.workflows) await loadWorkspaceWorkflows({ cwd: opts.cwd, registry: state.workflows });
  state.tools = {
    ...createCodingTools(envToolSource, {
    approveToolCall: approve,
    cwdLabel,
    onFileWrite: (change) => state.activeFileChanges?.push(change),
    onShellCommand: (command) => state.activeShellCommands?.push(command),
    }),
    recall: createRecallTool(() => state.cognitiveMemory),
    remember: createRememberTool(() => state.cognitiveMemory),
    task_ledger: createTaskLedgerTool(state, approve),
    ...(orchestrator ? {
      ...createDelegationTools({ orchestrator, approve }),
      ...createWorkflowTools({ orchestrator, registry: state.workflows!, cwd: opts.cwd, approve }),
    } : {}),
  };
  return state;
};

const buildSystemPromptFor = async (cwd: string, label: string): Promise<string> => {
  const { buildSystemPrompt } = await import("not-another-harness");
  const { loadContextFiles } = await import("./context.js");
  return buildSystemPrompt({ cwdLabel: label, contextFiles: await loadContextFiles(cwd) });
};
