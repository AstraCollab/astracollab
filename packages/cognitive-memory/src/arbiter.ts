/**
 * The model-backed arbiter, as a separate entry point.
 *
 * It needs `ai` and `zod`, and nothing else in this package does. Keeping it at
 * `cogmemory/arbiter` means a consumer who only wants the client or
 * the deterministic core is not made to install them, and does not get a peer
 * warning for a dependency they will never use.
 *
 * The arbiter is optional in the design too. Without it the engine promotes by
 * content-word overlap, which is what `CognitiveMemory` does by default — so a
 * deployment with no model configured still has working memory.
 */
export { createModelArbiter, type CreateModelArbiterOptions } from "./cognitive/arbiter"
export type { ArbiterEvaluationResult, ArbiterFn } from "./cognitive/types"
