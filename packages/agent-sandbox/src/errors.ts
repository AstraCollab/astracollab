/**
 * Custom error type for sandbox API failures. Carries `status`, `code`,
 * and optional `details`, and exposes semantic predicates so callers can
 * branch on intent rather than sniffing magic status codes.
 */
export class SandboxApiError extends Error {
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
    this.name = "SandboxApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  isQuotaError(): boolean {
    return this.status === 402 || this.code === "QUOTA_EXCEEDED";
  }

  isProvisioningError(): boolean {
    return this.code === "PROVISIONING_FAILED";
  }

  isAuthError(): boolean {
    return this.status === 401 || this.code === "UNAUTHORIZED";
  }

  isTimeoutError(): boolean {
    return this.status === 408 || this.code === "TIMEOUT";
  }

  isNotFoundError(): boolean {
    return this.status === 404;
  }

  isRetryable(): boolean {
    return (
      this.status >= 500 ||
      this.code === "RATE_LIMITED" ||
      this.isTimeoutError()
    );
  }
}

export const isSandboxApiError = (e: unknown): e is SandboxApiError =>
  e instanceof SandboxApiError;
