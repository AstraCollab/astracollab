/** Composer 2.5 model id on OpenAI-compatible Cursor inference endpoints. */
export const COMPOSER_25 = "composer-2.5" as const;

export type CursorModelId = typeof COMPOSER_25 | (string & {});

/** Documented Standard Agents proxy base URLs — opt-in only; never used as silent defaults. */
export const CURSOR_STANDARD_AGENTS_V1_BASE_URL =
  "https://cursor-api.standardagents.ai/v1" as const;

export const CURSOR_STANDARD_AGENTS_OPENCODE_BASE_URL =
  "https://cursor-api.standardagents.ai/opencode/v1" as const;

/** Published Composer 2.5 limits and list pricing (informational; billed via Cursor account). */
export const COMPOSER_25_LIMITS = {
  contextTokens: 200_000,
  maxOutputTokens: 65_536,
  costPerMillionInputUsd: 0.5,
  costPerMillionOutputUsd: 2.5,
} as const;

export const DEFAULT_CURSOR_TIMEOUT_MS = 60_000;
export const DEFAULT_CURSOR_RETRY = 2;

export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";
export const CURSOR_API_BASE_URL_ENV = "CURSOR_API_BASE_URL";
