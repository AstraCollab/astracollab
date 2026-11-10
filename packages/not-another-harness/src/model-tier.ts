/**
 * Strength tier of a model, used to route subtasks: weak/open-weight models get
 * small, structured, verifiable subtasks; strong models handle open-ended
 * planning.
 */
export type ModelTier = "weak" | "strong" | "unknown";

/**
 * Capabilities derived from a model id. Provider round-trips are avoided so this
 * stays synchronous and dependency-free; a wrong guess only degrades routing,
 * never breaks execution.
 */
export interface ModelCapabilities {
	tier: ModelTier;
	/** Approximate context window in tokens, or null when unknown. */
	contextWindow: number | null;
	/** Whether the model is known to follow JSON Schema / tool schemas strictly. */
	supportsStructuredOutput: boolean;
	/** Relative cost: "low", "medium", "high". */
	cost: "low" | "medium" | "high";
}

/**
 * Substrings that mark a model as weak/open-weight rather than a flagship.
 *
 * Model IDs are the only stable signal available without a provider call, so
 * these are heuristics.
 */
export const WEAK_MODEL_HINTS = [
	"llama",
	"qwen",
	"deepseek",
	"gemma",
	"mixtral",
	"mistral",
	"command-r",
	"dbrx",
	"nemotron",
	"phi",
	"starcoder",
	"codellama",
];

/**
 * Substrings that mark a model as a strong flagship.
 */
export const STRONG_MODEL_HINTS = [
	"claude",
	"gpt",
	"o1",
	"o3",
	"o4",
	"gemini",
	"sonnet",
	"opus",
	"haiku",
];

/**
 * Infer a model's tier from its id.
 */
export const inferModelTier = (modelId: string): ModelTier => {
	const id = modelId.toLowerCase();
	if (STRONG_MODEL_HINTS.some((hint) => id.includes(hint))) return "strong";
	if (WEAK_MODEL_HINTS.some((hint) => id.includes(hint))) return "weak";
	return "unknown";
};

/**
 * Default capabilities for a model, derived from its id.
 */
export const modelCapabilities = (modelId: string): ModelCapabilities => {
	const tier = inferModelTier(modelId);
	return {
		tier,
		contextWindow: null,
		supportsStructuredOutput: tier === "strong",
		cost: tier === "weak" ? "low" : tier === "strong" ? "high" : "medium",
	};
};

/**
 * Whether a model should be routed like a weak/open-weight model.
 *
 * `unknown` tiers are conservative: an unidentified model is routed like a weak
 * one (smaller subtasks, structured output, verification) rather than like a
 * flagship.
 */
export const isWeakModel = (modelId: string): boolean =>
	inferModelTier(modelId) !== "strong";
