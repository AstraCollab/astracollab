import {
  CURSOR_API_BASE_URL_ENV,
  CURSOR_API_KEY_ENV,
  DEFAULT_CURSOR_RETRY,
  DEFAULT_CURSOR_TIMEOUT_MS,
} from "./constants.js";
import type { CursorInferenceConfig } from "./types.js";

const readEnv = (key: string): string | undefined => {
  const value = process.env[key];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const resolveCursorConfigFromEnv = (): CursorInferenceConfig | null => {
  const apiKey = readEnv(CURSOR_API_KEY_ENV);
  const baseURL = readEnv(CURSOR_API_BASE_URL_ENV);

  if (!apiKey || !baseURL) {
    return null;
  }

  return {
    apiKey,
    baseURL,
    timeout: DEFAULT_CURSOR_TIMEOUT_MS,
    retry: DEFAULT_CURSOR_RETRY,
  };
};

export const resolveCursorConfigFromEnvOrThrow =
  (): CursorInferenceConfig => {
    const config = resolveCursorConfigFromEnv();
    if (!config) {
      throw new Error(
        `Missing ${CURSOR_API_KEY_ENV} and/or ${CURSOR_API_BASE_URL_ENV}. Both are required for Cursor inference.`,
      );
    }
    return config;
  };
