import type { LanguageModel, ModelMessage } from "ai";

/** Token usage reported for a step or an entire run. */
export type HarnessUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** Why an agent run ended. */
export type HarnessStopReason =
  | "completed" /** Model replied with no tool calls. */
  | "max-steps"
  | "max-tokens"
  | "aborted"
  | "error";

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
  | { type: "finish"; reason: HarnessStopReason; text: string; usage: HarnessUsage }
  | { type: "error"; error: unknown };

/** Pluggable working-directory backend for the built-in tools. */
export interface ToolEnvironment {
  /** Read a UTF-8 text file. Throws when the path is missing or binary. */
  readFile(path: string): Promise<string>;
  /** Write a UTF-8 text file, creating parent directories as needed. */
  writeFile(path: string, content: string): Promise<void>;
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
  }): Promise<string>;
  /** Run a shell command in the workspace root. */
  exec(
    command: string,
    opts?: { timeoutSeconds?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
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
  /** Cancel the run. */
  abortSignal?: AbortSignal;
  /**
   * Mid-run transcript compaction. "model" summarizes the older half with the
   * same model (default when compactAtTokens is set), "truncate" drops it
   * lossily, "off" never compacts. Default: "model".
   */
  compaction?: HarnessCompactionMode;
  /** Trigger compaction once cumulative tokens exceed this. Default 120_000. */
  compactAtTokens?: number;
  /** Messages to keep verbatim when compacting. Default 6. */
  compactKeepRecent?: number;
  /** Prior messages to continue from (e.g. restored session branch). */
  messages?: ModelMessage[];
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
};
