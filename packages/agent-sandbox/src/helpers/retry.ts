import type { RetryOptions } from "../types.js";
import { isSandboxApiError } from "../errors.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const defaultShouldRetry = (error: unknown): boolean => {
  if (isSandboxApiError(error)) {
    return error.isRetryable();
  }
  return true;
};

/**
 * Generic retry with exponential backoff.
 *
 * Defaults: 3 attempts, 250 ms base delay, 2x factor. Plain functions, no
 * decorator magic — easier to reason about than wrapping every call.
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> => {
  const attempts = options?.attempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 250;
  const factor = options?.factor ?? 2;
  const shouldRetry = options?.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(factor, attempt - 1);
      await sleep(delay);
    }
  }
  throw lastError;
};
