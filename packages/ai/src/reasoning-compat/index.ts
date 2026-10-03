/**
 * Reasoning-content compatibility for AI/ML-compatible gateways.
 *
 * Some gateways — AIML among them — reject an assistant message that carries a
 * tool call unless that same message also carries a non-empty
 * `reasoning_content`. The error reads:
 *
 *   reasoning_content is missing in assistant tool call message
 *
 * It is a field-presence requirement, not a request for reasoning. The gateway
 * will not tell you what the model was thinking; it only insists the field is
 * there so its own bookkeeping round-trips. This module satisfies that with a
 * blank placeholder and changes nothing else.
 *
 * **It is language-model middleware, not a harness feature, on purpose.** The
 * requirement belongs to the provider, so implementing it here fixes it for every
 * consumer at once — Mastra, NAH, or a bare `streamText` call. Wrap the model,
 * hand it to whatever already runs your agent, and the behaviour comes along with
 * no change to the loop.
 *
 * What it will not do is invent reasoning. The placeholder is blank by design:
 * fabricating a plausible chain of thought would be worse than the error, because
 * the next turn would condition on something that never happened.
 */
import type { LanguageModelV2Middleware } from "@ai-sdk/provider";

/**
 * The value sent as `reasoning_content`.
 *
 * A single space, and that is load-bearing. The gateway treats an absent *or
 * empty* value as missing, so `""` reintroduces the exact error this module
 * exists to remove. Do not "tidy" this to an empty string.
 */
export const REASONING_CONTENT_PLACEHOLDER = " ";

/**
 * Provider messages that mean the placeholder is required.
 *
 * Matched against the error text rather than a status code, because these
 * gateways answer 400 with a prose body and no machine-readable field.
 */
export const MISSING_REASONING_ERROR_PATTERNS: readonly RegExp[] = [
  /reasoning_content is missing in assistant tool call message/i,
  /reasoning_content.*must be passed back/i,
  /reasoning_content.*is required/i,
];

/** True when an error is the gateway asking for the field we can supply. */
export const isMissingReasoningContentError = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : "";
  return MISSING_REASONING_ERROR_PATTERNS.some((pattern) => pattern.test(message));
};

/**
 * Models known to require the round-trip.
 *
 * A floor, not a ceiling: gateways add models, and a shared package is the wrong
 * place to hardcode a list that will be stale within a month. Pass `extraModels`
 * to add to it.
 */
export const isGatewayThinkingModel = (modelId: string): boolean => {
  const id = modelId.toLowerCase();
  if (id.includes("deepseek")) return true;
  // Kimi K2.5 / K2.6, spelled both with a dot and with a dash in the wild.
  return id.includes("kimi-k2-5") || id.includes("kimi-k2-6") || id.includes("kimi-k2.5") || id.includes("kimi-k2.6");
};

const TRUTHY = new Set(["1", "true", "on", "yes", "enabled", "enable"]);
const FALSY = new Set(["0", "false", "off", "no", "disabled", "disable"]);

/** Read the thinking setting. Unset is neither: the prompt itself decides. */
export const readThinkingSetting = (
  env: Record<string, string | undefined>,
  variable = "THINKING",
): "enabled" | "disabled" | "unset" => {
  const raw = env[variable]?.trim().toLowerCase();
  if (!raw) return "unset";
  if (FALSY.has(raw)) return "disabled";
  if (TRUTHY.has(raw)) return "enabled";
  return "unset";
};

/* The prompt is handled structurally rather than through a provider type.
 *
 * This module is imported by consumers on three AI SDK majors, and the
 * message-part types are not identical across them. Describing only the shape
 * that is actually tested — role, content array, part types — keeps one
 * implementation working across all three, and keeps the checks honest about the
 * only property that matters: does this assistant message call a tool. */
export type CompatPart = { type?: string; text?: unknown; reasoning?: unknown };
export type CompatMessage = { role?: string; content?: unknown };
export type CompatPrompt = CompatMessage[];

const isAssistant = (message: CompatMessage): boolean => message.role === "assistant";

/** Assistant messages that call a tool: the ones the gateway rejects. */
export const callsATool = (message: CompatMessage): boolean =>
  Array.isArray(message.content) && message.content.some((part) => (part as CompatPart)?.type === "tool-call");

export const hasReasoningPart = (message: CompatMessage): boolean =>
  Array.isArray(message.content) && message.content.some((part) => (part as CompatPart)?.type === "reasoning");

const reasoningText = (part: CompatPart): string => String(part.text ?? part.reasoning ?? "");

/**
 * Does the history already show a thinking round-trip?
 *
 * This is how the default (no `THINKING` set) resolves: a conversation that once
 * carried reasoning alongside a tool call is mid-round-trip, so continuing to
 * carry it is the consistent choice. A first turn with no history is untouched.
 */
export const historyRequiresReasoning = (prompt: CompatPrompt): boolean =>
  prompt.some(
    (message) =>
      isAssistant(message) &&
      callsATool(message) &&
      hasReasoningPart(message) &&
      (message.content as CompatPart[]).some(
        (part) => part.type === "reasoning" && reasoningText(part).trim().length > 0,
      ),
  );

/**
 * Add the blank field where the gateway needs one.
 *
 * Idempotent by construction: a message that already has a reasoning part is left
 * exactly as it is, so the model's own reasoning survives the round-trip instead
 * of being overwritten by a placeholder.
 *
 * Returns `undefined` when nothing changed, so a caller can tell "already
 * correct" from "rewritten" without diffing.
 */
export const injectReasoningPlaceholders = (prompt: CompatPrompt): CompatPrompt | undefined => {
  let mutated = false;
  const next = prompt.map((message) => {
    if (!isAssistant(message) || !Array.isArray(message.content)) return message;
    if (!callsATool(message) || hasReasoningPart(message)) return message;
    mutated = true;
    return {
      ...message,
      content: [{ type: "reasoning" as const, text: REASONING_CONTENT_PLACEHOLDER }, ...message.content],
    };
  });
  return mutated ? next : undefined;
};

/** Remove reasoning from assistant messages, for when thinking is off. */
export const stripReasoning = (
  prompt: CompatPrompt,
  options: { placeholdersOnly?: boolean } = {},
): CompatPrompt | undefined => {
  let mutated = false;
  const next = prompt.map((message) => {
    if (!isAssistant(message) || !Array.isArray(message.content)) return message;
    const parts = message.content as CompatPart[];
    const kept = parts.filter((part) => {
      if (part.type !== "reasoning") return true;
      // `placeholdersOnly` keeps the model's real reasoning and drops only what
      // this module added. Useful when thinking is turned off mid-conversation:
      // reasoning the model actually produced is still context, and discarding it
      // changes what the model can see.
      if (!options.placeholdersOnly) return false;
      return reasoningText(part).trim() !== "";
    });
    if (kept.length === parts.length) return message;
    mutated = true;
    return { ...message, content: kept };
  });
  return mutated ? next : undefined;
};

export type RewriteMode = "inject" | "strip";

/** Decide what to do with one prompt. `undefined` means leave it alone. */
export const resolveRewriteMode = (options: {
  modelId: string;
  prompt: CompatPrompt;
  setting: "enabled" | "disabled" | "unset";
  extraModels?: readonly string[];
}): RewriteMode | undefined => {
  const known =
    isGatewayThinkingModel(options.modelId) ||
    (options.extraModels?.some((id) => id.toLowerCase() === options.modelId.toLowerCase()) ?? false);
  if (!known) return undefined;
  if (options.setting === "disabled") return "strip";
  if (options.setting === "enabled") return "inject";
  return historyRequiresReasoning(options.prompt) ? "inject" : undefined;
};

export type ReasoningContentCompatOptions = {
  /**
   * Extra model ids to treat as gateway thinking models.
   *
   * Matched case-insensitively and exactly. Prefix matching would catch
   * `deepseek-r1-distill-*` on one provider and miss it on another.
   */
  extraModels?: readonly string[];
  /** Environment variable holding the thinking setting. Default `THINKING`. */
  envVar?: string;
  /** Environment to read. Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>;
  /**
   * When thinking is disabled, drop only the placeholders rather than every
   * reasoning part.
   *
   * Default false, which is what the gate has always done. See `stripReasoning`.
   */
  stripPlaceholdersOnly?: boolean;
  /**
   * Re-send once with the field injected when the provider asks for it.
   *
   * Default true. The preventive transform rewrites the whole prompt, history
   * included, so in practice this never fires — it covers the case where our
   * model of the gateway's rule is wrong, which is the only way the error can
   * still appear. Costs one duplicate request when it does.
   */
  healOnError?: boolean;
};

const modelIdOf = (model: unknown): string => {
  if (model == null) return "";
  if (typeof model === "string") return model;
  const modelId = (model as { modelId?: unknown }).modelId;
  return typeof modelId === "string" ? modelId : "";
};

/**
 * Rewrite a prompt the way the gateway requires.
 *
 * Exported separately from the middleware because a consumer also needs it for
 * history that is already stored: the middleware fixes what is about to be sent,
 * and this fixes what is already on disk.
 */
export const applyReasoningContentCompat = (
  prompt: unknown,
  options: ReasoningContentCompatOptions & { modelId: string },
): unknown => {
  if (!Array.isArray(prompt)) return prompt;
  const mode = resolveRewriteMode({
    modelId: options.modelId,
    prompt: prompt as CompatPrompt,
    setting: readThinkingSetting(options.env ?? process.env, options.envVar ?? "THINKING"),
    ...(options.extraModels === undefined ? {} : { extraModels: options.extraModels }),
  });
  if (mode === undefined) return prompt;
  return (
    mode === "strip"
      ? stripReasoning(prompt as CompatPrompt, { placeholdersOnly: options.stripPlaceholdersOnly })
      : injectReasoningPlaceholders(prompt as CompatPrompt)
  ) ?? prompt;
};

/**
 * The middleware.
 *
 * Wrap with `wrapLanguageModel` from `ai` and hand the result to your agent.
 *
 * **It prevents; it cannot self-heal.** `wrapGenerate` hands over a `doGenerate`
 * that is already bound to the request parameters, so there is no way to reissue
 * the same call with a rewritten prompt from inside middleware. A consumer that
 * wants the retry behaviour — catching `isMissingReasoningContentError` and
 * re-running the turn with `applyReasoningContentCompat` applied to its stored
 * messages — needs to own that retry, because only it owns the history. In
 * practice the transform is enough and the retry never fires.
 */
export const createReasoningContentCompat = (
  options: ReasoningContentCompatOptions = {},
): LanguageModelV2Middleware => ({
  transformParams: async ({ params, model }) => {
    const rewritten = applyReasoningContentCompat(params.prompt, { ...options, modelId: modelIdOf(model) });
    return rewritten === params.prompt
      ? params
      : { ...params, prompt: rewritten as typeof params.prompt };
  },
  ...
    (options.healOnError === false
      ? {}
      : {
          wrapGenerate: (args) => heal(() => args.doGenerate(), args.params),
          wrapStream: (args) => heal(() => args.doStream(), args.params),
        }),
});

/**
 * Retry once with the field injected.
 *
 * The AI SDK type says `doGenerate()` takes no arguments, which reads as
 * "middleware cannot reissue this call with different parameters" — and the type
 * is not wrong, because the call is already bound. It is bound to a *closure
 * over* the params object:
 *
 * ```js
 * const transformedParams = await doTransform({ params, type: "generate" });
 * const doGenerate = async () => await model.doGenerate(transformedParams);
 * return wrapGenerate({ doGenerate, params: transformedParams, model });
 * ```
 *
 * The object handed to the middleware as `params` is that same
 * `transformedParams`. Assigning `params.prompt` and calling again therefore
 * re-sends the rewritten prompt, verified against the v5 and v7 builds of `ai`.
 * That is a side channel rather than a documented contract, so two things protect
 * it: the retry happens exactly once and lets any second failure propagate, and
 * `reasoning-compat.test.ts` exercises the heal, so an SDK release that copies the
 * params instead of aliasing them fails here rather than quietly starting a second
 * request with the same broken body.
 *
 * `call` is passed in rather than closed over because the SDK hands a middleware
 * *both* call functions — `doStream` is given `doGenerate` too. Picking the wrong
 * one turns every streaming call into a non-streaming request, which is why the
 * two wrappers are separate rather than one function with two arguments.
 */
const heal = async <T>(call: () => PromiseLike<T>, params: { prompt?: unknown }): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    if (!isMissingReasoningContentError(error)) throw error;
    const prompt = injectReasoningPlaceholders(params.prompt as CompatPrompt);
    // Nothing to add means the rule is not the one we modelled, so a retry would
    // fail identically and would have cost a request for the privilege.
    if (!prompt) throw error;
    params.prompt = prompt;
    return call();
  }
};