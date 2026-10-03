/**
 * The coding agent, on `not-another-harness`.
 *
 * ## The one thing to check when reading a port
 *
 * Mastra's `prepareStep` gets a **0-based** `stepNumber`; the harness's is
 * **1-based**, matching its `step-start` event and `onStepStart`. The rule
 * `stepNumber === 0` in the Mastra agent means the *first* step, and becomes
 * `stepNumber === 1` here.
 *
 * That is the whole class of bug this migration has: a bound moved by one, which
 * typechecks, passes review, and quietly requires a tool one step too late. So
 * every step-indexed rule here carries the number it was ported from.
 */
import { runAgent, type HarnessRun, type HarnessRunResult, type ToolEnvironment } from "not-another-harness";
import { createCodingTools } from "not-another-harness";
import type { ToolSet } from "ai";

import { wrapToolsWithSanitisers, type ToolSanitisers } from "./tool-input.js";

/** `implement` edits files; `scout` reads. Drives the step ceiling and the tool rule. */
export type HarnessMode = "scout" | "implement";

export type CodingAgentOptions = {
  model: Parameters<typeof runAgent>[0]["model"];
  environment: ToolEnvironment;
  /** Approve a mutating tool call. `ask` is the default posture, not `allow`. */
  approve: (toolName: string) => Promise<boolean>;
  mode?: HarnessMode;
  /** Tighter ceilings and a shorter git-verify stop, for a profiled repository. */
  fastPath?: boolean;
  /** Keep `toolChoice: "required"` until the run has called a tool at all. */
  forceToolChoiceUntilFirstTool?: boolean;
  /** Require a tool on the first step of an implement run. */
  requireFirstTool?: boolean;
  /** Models that must not be forced into a tool call. */
  mustUseAutoToolChoice?: (modelId: string, stepNumber: number) => boolean;
  /** Tools treated as "the agent did the work", for the implement-mode rule. */
  writeTools?: readonly string[];
  maxSteps?: number;
  system?: string;
  /** Per-tool overrides on top of the built-in sanitisers. */
  sanitisers?: ToolSanitisers;
};

export const DEFAULT_WRITE_TOOLS = ["write", "write_file", "edit", "edit_file", "apply_patch"] as const;

/**
 * The harness's tools, sanitised.
 *
 * The harness keeps validating strictly — coercion happens here, at the traffic
 * edge, so a harness that has never seen `"True"` still rejects it.
 */
export const buildCodingTools = (
  options: Pick<CodingAgentOptions, "environment" | "approve" | "sanitisers">,
): ToolSet =>
  wrapToolsWithSanitisers(
    createCodingTools(options.environment, {
      approveToolCall: async (toolName: string) => options.approve(toolName),
      cwdLabel: "workspace",
    }) as ToolSet,
    options.sanitisers ?? {},
  );

/** Did any step in this run call a tool? */
export const hasCalledATool = (steps: ReadonlyArray<{ toolNames: readonly string[] }>): boolean =>
  steps.some((entry) => entry.toolNames.length > 0);

/** Did the run use a tool that writes? Drives the implement-mode "it must act" rule. */
export const hasWritten = (
  steps: ReadonlyArray<{ toolNames: readonly string[] }>,
  writeTools: readonly string[] = DEFAULT_WRITE_TOOLS,
): boolean =>
  steps.some((entry) => entry.toolNames.some((name) => writeTools.includes(name)));

/**
 * The per-step rule, ported from the Mastra agent.
 *
 * Kept as its own function so it can be tested against a step list without
 * running an agent — which is the only practical way to check a bound like
 * `stepNumber === 1`.
 */
export const createPrepareStep = (options: {
  mode: HarnessMode;
  modelId: string;
  forceToolChoiceUntilFirstTool?: boolean;
  requireFirstTool?: boolean;
  mustUseAutoToolChoice?: (modelId: string, stepNumber: number) => boolean;
  writeTools?: readonly string[];
}) => {
  const mustAuto = options.mustUseAutoToolChoice ?? (() => false);
  const mode = options.mode;
  const requireFirstTool = mode === "implement" && options.requireFirstTool === true;
  // Mastra's `!codingAgentMustUseAutoToolChoice(modelId, 0)` guard, evaluated
  // against step **0**. Here that is step 1.
  const requireFirstToolAllowed = requireFirstTool && !mustAuto(options.modelId, 1);

  return ({
    stepNumber,
    steps,
  }: {
    stepNumber: number;
    steps: ReadonlyArray<{ step: number; toolNames: readonly string[] }>;
  }): { toolChoice: "required" | "auto" } => {
    // Ported: `forceToolChoiceUntilFirstTool && !stepHasAnyToolCall(steps) && !mustAuto(...)`.
    if (
      options.forceToolChoiceUntilFirstTool === true &&
      !hasCalledATool(steps) &&
      !mustAuto(options.modelId, stepNumber)
    ) {
      return { toolChoice: "required" };
    }
    if (mustAuto(options.modelId, stepNumber)) {
      return { toolChoice: "auto" };
    }
    // Ported from `stepNumber === 0`, which was the first step under Mastra's
    // 0-based numbering.
    if (requireFirstToolAllowed && stepNumber === 1) {
      return { toolChoice: "required" };
    }
    if (requireFirstToolAllowed && !hasWritten(steps, options.writeTools) && stepNumber >= 2) {
      return { toolChoice: "required" };
    }
    return { toolChoice: "auto" };
  };
};

export type CodingAgentRunOptions = CodingAgentOptions & {
  prompt: string;
  messages?: Parameters<typeof runAgent>[0]["messages"];
  /** Recorded as trace tags and metadata, so a run is findable afterwards. */
  workflow?: string;
};

/**
 * Build a run rather than executing it.
 *
 * Returning the handle, not a promise of a result, is what lets a caller stream
 * events, steer a running turn, or record the trace — all of which the caller
 * already does today, and none of which should have to be re-implemented to move
 * off Mastra.
 */
export const createCodingAgentRun = (options: CodingAgentRunOptions): HarnessRun => {
  const mode = options.mode ?? "implement";
  const modelId = (options.model as { modelId?: string }).modelId ?? "";
  const prepareStep =
    mode === "implement"
      ? createPrepareStep({
          mode,
          modelId,
          forceToolChoiceUntilFirstTool: options.forceToolChoiceUntilFirstTool === true,
          requireFirstTool: options.requireFirstTool === true,
          ...(options.mustUseAutoToolChoice ? { mustUseAutoToolChoice: options.mustUseAutoToolChoice } : {}),
          ...(options.writeTools ? { writeTools: options.writeTools } : {}),
        })
      : undefined;

  return runAgent({
    model: options.model,
    system: options.system ?? "",
    prompt: options.prompt,
    ...(options.messages ? { messages: options.messages } : {}),
    tools: buildCodingTools(options),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(prepareStep ? { prepareStep } : {}),
    ...(options.workflow ? { tags: ["coding-agent", options.workflow] } : {}),
  });
};

/** Await a run to completion, for callers with nothing to stream. */
export const runCodingAgent = async (options: CodingAgentRunOptions): Promise<HarnessRunResult> => {
  const run = createCodingAgentRun(options);
  for await (const _ of run.events) {
    // Drained so the loop is never blocked on an unconsumed queue.
  }
  return run.result;
};