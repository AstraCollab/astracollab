import type { CognitiveMemoryErrorBody } from "./types"

/**
 * One error class for every failure the service can produce.
 *
 * The service already returns a structured envelope — a tag, a message, the
 * scope that was missing, the fields that failed validation — so the SDK's job is
 * to hand that over as a typed object instead of making callers dig through
 * `error.response.data`.
 *
 * The predicate methods exist so callers ask semantic questions. `status === 403`
 * scatters a magic number through every integration and means something slightly
 * different at each one; `isScopeError()` means the same thing everywhere.
 */
export class CognitiveMemoryError extends Error {
  /**
   * Set as a real value, because a minifier renames the class and that silently
   * changes what monitoring groups on. `error.name` is correct either way — the
   * constructor assigns it — but `SomeError.name` and `error.constructor.name`
   * are how a reporter identifies a class, and a minified `"h"` breaks that.
   */
  static override readonly name = "CognitiveMemoryError"

  /** The service's own tag: `Unauthorized`, `Forbidden`, `InvalidRequest`, … */
  readonly code: string
  readonly status: number
  /** Present on a 403: the scope the key would have needed. */
  readonly requiredScope?: string
  /** Present on a 400: which field, and why. */
  readonly issues?: string[]
  readonly body?: CognitiveMemoryErrorBody

  constructor(
    message: string,
    init: {
      status: number
      code: string
      body?: CognitiveMemoryErrorBody
      requiredScope?: string
      issues?: string[]
    }
  ) {
    super(message)
    this.name = "CognitiveMemoryError"
    this.status = init.status
    this.code = init.code
    this.body = init.body
    this.requiredScope = init.requiredScope
    this.issues = init.issues

    // Keeps the constructor out of the stack, so the first frame is the caller.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CognitiveMemoryError)
    }
  }

  /** The key is missing, malformed, expired or revoked. */
  isAuthError(): boolean {
    return this.status === 401
  }

  /** The key is valid but lacks a scope. `requiredScope` says which. */
  isScopeError(): boolean {
    return this.status === 403
  }

  /** The request body did not match the schema. `issues` says where. */
  isValidationError(): boolean {
    return this.status === 400
  }

  /** Nothing exists at that id — or it belongs to another organisation. */
  isNotFoundError(): boolean {
    return this.status === 404
  }

  isRateLimitError(): boolean {
    return this.status === 429
  }

  /** A dependency of ours failed, not the request. Safe to retry. */
  isServerError(): boolean {
    return this.status >= 500
  }
}
