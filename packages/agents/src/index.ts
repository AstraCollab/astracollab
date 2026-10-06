/**
 * `@astracollab/agents` — the @astracollab/client agent surface, on NAH.
 *
 * ## Why this package exists
 *
 * The tools and the input sanitisers belong to the product, not to the harness.
 * "This provider emits `True` for a boolean" and "this tool must not be forced
 * into a call" are facts about traffic and policy; they change monthly, and
 * putting them in the harness would make it learn about one customer.
 *
 * So the harness stays a harness — loop, tiers, tools, budgets, telemetry — and
 * everything client-shaped lives here.
 */
export {
  coerceOptionalBoolean,
  coerceOptionalNumber,
  coerceOptionalString,
  isBlank,
  sanitiseEditInput,
  sanitiseExecuteInput,
  sanitiseListFilesInput,
  sanitiseReadInput,
  sanitiseWriteInput,
  sanitiserFor,
  wrapToolsWithSanitisers,
  type ToolSanitisers,
} from "./tool-input.js";
export {
  calledTool,
  dedupeAndCapSummary,
  executeCommandsFrom,
  summaryFrom,
  toolNamesFrom,
  usageSummary,
  wroteFiles,
} from "./run-shape.js";
export {
  createAntiLoopStop,
  evaluateAntiLoop,
  isGitVerificationCommand,
  isHallucinatedToolName,
  reconstructSteps,
  resolveGitVerifyStreak,
  resolveHallucinatedToolStreak,
  resolveValidationFailureStreak,
  type AntiLoopOptions,
  type AntiLoopVerdict,
  type ReconstructedStep,
  type ShouldStopOptions,
} from "./anti-loop.js";
export {
  createMemoryCircuitBreaker,
  loadMemory,
  saveMemory,
  type MemoryLoad,
  type MemorySave,
  type MemorySource,
} from "./memory.js";
export {
  createFallbackMemory,
  createInMemoryMemory,
  createWindowedMemory,
  createInMemoryThreadStore,
  type DurableThreadStore,
  type FallbackMemoryOptions,
  type ReadOnlyThreadStore,
} from "./memory-stores.js";
export {
  buildMemoryContext,
  learnFromTurn,
  runWithMemory,
  withMemoryContext,
  type CognitiveMemoryLike,
  type CognitiveMemoryOptions,
} from "./memory-cognitive.js";
export { withExtraTools } from "./tools.js";
export {
  logImplementTurn,
  resolveImplementStepCap,
  resolveStepCap,
  turnLogEnabled,
  type StepCapOptions,
  type TurnLogInput,
} from "./turn-log.js";
export {
  buildCodingTools,
  createCodingAgentRun,
  createPrepareStep,
  DEFAULT_WRITE_TOOLS,
  hasCalledATool,
  hasWritten,
  runCodingAgent,
  type CodingAgentOptions,
  type CodingAgentRunOptions,
  type HarnessMode,
} from "./coding-agent.js";
