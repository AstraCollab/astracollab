import type { LanguageModel, ModelMessage } from "ai";

/** Token usage reported for a step or an entire run. */
export type HarnessUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** True when one or more step totals had to be estimated from text length. */
  estimated?: boolean;
};

/** Why an agent run ended. */
export type HarnessStopReason =
  | "completed" /** Model replied with no tool calls. */
  | "max-steps"
  | "max-tokens"
  | "aborted"
  | "error";

export type WorkspaceSnapshotEntry =
  | { kind: "directory"; mode: number }
  | { kind: "file"; mode: number; contentBase64: string }
  | { kind: "symlink"; mode: number; target: string };

export type WorkspaceSnapshot = {
  complete: boolean;
  entries: Record<string, WorkspaceSnapshotEntry>;
  excludedPaths: string[];
  reason?: string;
};

export type WorkspaceRestoreResult = { restoredPaths: string[]; conflicts: string[] };

/** How a mid-run user message is delivered into the transcript. */
export type HarnessSteerDelivery = "steer" | "follow-up";

/** Streaming events emitted while the agent loop runs. */
export type HarnessEvent =
  | { type: "run-start"; stepBudget: number; tokenBudget: number }
  | { type: "step-start"; step: number }
  | { type: "text-delta"; step: number; text: string }
  | { type: "tool-call"; step: number; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      step: number;
      toolCallId: string;
      toolName: string;
      /** Text form of the (already output-capped) result. */
      output: string;
      isError: boolean;
    }
  | { type: "step-finish"; step: number; usage: HarnessUsage }
  | { type: "compacted"; droppedMessages: number; keptMessages: number; summaryChars: number }
  /**
   * A user message sent while the run was in flight. `queued` fires when the
   * harness accepts it, `delivered` when it actually enters the transcript —
   * these are different moments, and a UI needs both to show a pending chip
   * that clears once the model can see it.
   */
  | {
      type: "user-message";
      text: string;
      delivery: HarnessSteerDelivery;
      phase: "queued" | "delivered";
    }
  | { type: "finish"; reason: HarnessStopReason; text: string; usage: HarnessUsage }
  | { type: "error"; error: unknown };

/** Pluggable working-directory backend for the built-in tools. */
export interface ToolEnvironment {
  /** Read a UTF-8 text file. Throws when the path is missing or binary. */
  readFile(path: string): Promise<string>;
  /** Write a UTF-8 text file, creating parent directories as needed. */
  writeFile(path: string, content: string): Promise<void>;
  /** Remove a file created in the workspace. */
  deleteFile?(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Single-level directory listing of `dir`. */
  readdir(dir: string): Promise<Array<{ name: string; type: "file" | "directory" }>>;
  /**
   * Content search. Returns newline-delimited `path:line: text` matches
   * (relative paths preferred). Empty string when there are no matches.
   */
  grep(opts: {
    pattern: string;
    /** Narrow to a file/dir or glob, repo-relative. */
    path?: string;
    ignoreCase?: boolean;
    maxPerFile?: number;
    includeHidden?: boolean;
  }): Promise<string>;
  /**
   * Find files by glob pattern (`*`, `**`, `?`, `{a,b}`), workspace-relative.
   * Returns matching paths sorted with directories shallowest-first. Optional:
   * the built-in `glob` tool is only registered when the environment supports it.
   */
  glob?(opts: {
    pattern: string;
    /** Directory to search under (default the workspace root). */
    path?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<string[]>;
  /**
   * Run a shell command in the workspace root. Implementations must honour
   * `signal` so an aborted run stops promptly, and must not leave the command
   * reading from an open stdin (that blocks until the timeout).
   */
  exec(
    command: string,
    opts?: { timeoutSeconds?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Optional complete snapshot of workspace files for safe per-step recovery. */
  snapshot?(): Promise<WorkspaceSnapshot>;
  /** Restore paths only if current contents still match the expected post-step snapshot. */
  restoreSnapshot?(before: WorkspaceSnapshot, after: WorkspaceSnapshot, paths: string[]): Promise<WorkspaceRestoreResult>;
}

export type HarnessCompactionMode = "model" | "truncate" | "off";

export type HarnessRunOptions = {
  /** Any AI SDK v5 language model. */
  model: LanguageModel;
  /** The task/instruction (becomes the first user message). */
  prompt: string;
  /** Full system prompt (see `buildSystemPrompt` for the Pi-style builder). */
  system: string;
  /** Tool set — use `createCodingTools` or bring your own (`tool()` map). */
  tools: Record<string, unknown>;
  /** Hard step cap (one step = one model round-trip + its tool calls). Default 32. */
  maxSteps?: number;
  /** Hard cumulative token cap for the run. Default 400_000; 0 disables. */
  maxTokens?: number;
  /** Maximum generated tokens for one model response. Default 8_192. */
  maxOutputTokens?: number;
  /** Cancel the run. */
  abortSignal?: AbortSignal;
  /**
   * Mid-run transcript compaction. "model" summarizes the older half with the
   * same model (default when compactAtTokens is set), "truncate" drops it
   * lossily, "off" never compacts. Default: "model".
   */
  compaction?: HarnessCompactionMode;
  /**
   * Trigger compaction when the *next request* would carry roughly this many
   * input tokens. Measured from the last step's reported input count, so
   * repeated re-sending of the transcript does not inflate the trigger. Default
   * 120_000.
   */
  compactAtTokens?: number;
  /** Messages to keep verbatim when compacting. Default 6. */
  compactKeepRecent?: number;
  /** Prior messages to continue from (e.g. restored session branch). */
  messages?: ModelMessage[];
  /**
   * Provider id used to decide whether prompt caching applies, e.g. "anthropic".
   * Set it to opt into Anthropic-style cache breakpoints.
   */
  cacheProvider?: string;
  /** Cache lifetime for breakpoints. 5m is cheaper, 1h holds across longer runs. */
  cacheTtl?: "5m" | "1h";
  /**
   * Server-side context editing: ask the API to clear old tool results and
   * replace them with placeholders. Applied only for providers that support it.
   */
  contextEditing?: {
    /** Input tokens that trigger clearing. Default 40_000. */
    triggerTokens?: number;
    /** Recent tool rounds kept intact. Default 6. */
    keepToolUses?: number;
    /** Tools whose results are never cleared. */
    excludeTools?: readonly string[];
  };
  /** Optional awaited callbacks at each model step boundary. */
  onStepStart?: (step: number, messages: ModelMessage[]) => void | Promise<void>;
  onStepFinish?: (step: number, messages: ModelMessage[]) => void | Promise<void>;
};

export type HarnessRunResult = {
  text: string;
  reason: HarnessStopReason;
  steps: number;
  usage: HarnessUsage;
  /** Full transcript after the run (append + persist for sessions). */
  messages: ModelMessage[];
  /** Number of compactions performed during the run. */
  compactions: number;
};

export type HarnessRun = {
  /** Typed event stream — drive UIs / JSONL logs from this. */
  events: AsyncIterable<HarnessEvent>;
  result: Promise<HarnessRunResult>;

  /**
   * Send a message while the run is in flight. It is appended to the transcript
   * at the next step boundary — after the current step's tool calls settle, and
   * before the next model request — so the in-flight call is never cut off
   * mid-token. Returns false if the run has already settled.
   *
   * Steers jump ahead of follow-ups.
   */
  steer(text: string): boolean;

  /**
   * Send a message that is delivered only if the run would otherwise finish.
   * Use this for "also, once you're done, ..." so a mid-run nudge does not
   * derail the task already in flight.
   */
  followUp(text: string): boolean;

  /**
   * Abort the run (the equivalent of pressing Escape). Unlike steering this
   * *does* cut off the in-flight model call and any running tool. Queued
   * messages are left intact so the caller can decide whether to replay them.
   */
  interrupt(): void;

  /** Currently queued messages, for rendering a pending indicator. */
  pending(): { steer: readonly string[]; followUp: readonly string[] };
};
