/**
 * The deterministic cognitive layer, as a separate entry point.
 *
 * ## Why this exists
 *
 * The root entry pulls in the HTTP client, and the client needs `ofetch` — declared
 * as a peer dependency and left external on purpose, because bundling it would ship a
 * second copy inside every consumer that already has one.
 *
 * That makes `cogmemory` unusable for the many consumers who only want the
 * **in-process engine**: `import { CognitiveMemory } from "cogmemory"` resolves a
 * module whose top-level `import { ofetch } from "ofetch"` throws
 * `ERR_MODULE_NOT_FOUND` in any project that does not already depend on `ofetch` —
 * including a pnpm workspace, where an undeclared or unhoisted package does not
 * resolve at all, and where npm's automatic peer installation does not apply.
 *
 * A top-level import of a module you never call still throws. The engine makes zero
 * network calls, so requiring a HTTP library to use it is pure cost.
 *
 * So: `cogmemory/engine` for the deterministic core, with no `ofetch`, no `ai` and no
 * `zod`. The root entry keeps everything, because a deployment talking to the service
 * should not have to know which half it needs.
 *
 * ```ts
 * import { CognitiveMemory } from "cogmemory/engine"   // no ofetch needed
 * import { createClient } from "cogmemory"            // needs ofetch
 * ```
 */
export { CognitiveMemory } from "./cognitive/memory.js"
export { runFastGate, extractDomains, type FastGateResult } from "./cognitive/fast-gate.js"
export {
  relevanceTokens,
  overlapScore,
  distinctiveTokens,
  isLossyRewrite,
  extractIdentifiers,
  isInteractionScoped,
  similarity,
} from "./cognitive/relevance.js"
export { extractDeterministic, type DeterministicMemory } from "./cognitive/rules.js"
export type {
  ArbiterEvaluationResult,
  ArbiterFn,
  MemoryInjectionReport,
  MemoryItem,
  MemoryTier,
  KnowledgeTension,
  ProprioceptiveSelfModel,
  CognitiveMemoryStateSnapshot,
  CognitiveMemoryOptions,
} from "./cognitive/types.js"