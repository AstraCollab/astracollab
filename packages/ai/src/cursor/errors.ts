/**
 * Custom error for Cursor inference API failures.
 */
export class CursorApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CursorApiError";
    this.status = status;
    this.code = code;
    this.details = details;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CursorApiError);
    }
  }

  isAuthError(): boolean {
    return this.status === 401 || this.code === "UNAUTHORIZED";
  }

  isRateLimitError(): boolean {
    return this.status === 429 || this.code === "RATE_LIMITED";
  }

  isValidationError(): boolean {
    return this.status === 422 || this.code === "VALIDATION_ERROR";
  }

  isRetryable(): boolean {
    return (
      this.status >= 500 ||
      this.isRateLimitError() ||
      this.status === 408 ||
      this.code === "TIMEOUT"
    );
  }
}

export const isCursorApiError = (error: unknown): error is CursorApiError =>
  error instanceof CursorApiError;

export const mapStatusToCode = (status: number): string => {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 402) return "QUOTA_EXCEEDED";
  if (status === 404) return "NOT_FOUND";
  if (status === 408) return "TIMEOUT";
  if (status === 422) return "VALIDATION_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "BAD_REQUEST";
};
