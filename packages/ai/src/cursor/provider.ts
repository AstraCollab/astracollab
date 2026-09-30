import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { COMPOSER_25 } from "./constants.js";
import { assertCursorInferenceConfig } from "./client.js";
import type { CursorModelId, CursorProviderConfig } from "./types.js";

export type CursorProvider = ReturnType<typeof createOpenAICompatible>;

export const createCursorProvider = (
  config: CursorProviderConfig,
): CursorProvider => {
  assertCursorInferenceConfig(config);

  return createOpenAICompatible({
    name: config.name ?? "cursor",
    apiKey: config.apiKey,
    baseURL: config.baseURL.replace(/\/+$/, ""),
  });
};

export const createComposerModel = (
  config: CursorProviderConfig,
  modelId: CursorModelId = COMPOSER_25,
): LanguageModel => createCursorProvider(config).chatModel(modelId);
