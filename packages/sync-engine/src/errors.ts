export type SyncEngineErrorCode =
  | "INVALID_CONTEXT"
  | "INVALID_QUERY_ARGS"
  | "UNSUPPORTED_OPERATION";

export class SyncEngineError extends Error {
  constructor(
    message: string,
    public readonly code: SyncEngineErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SyncEngineError";
  }

  isInvalidContext(): boolean {
    return this.code === "INVALID_CONTEXT";
  }

  isInvalidQueryArgs(): boolean {
    return this.code === "INVALID_QUERY_ARGS";
  }

  isUnsupportedOperation(): boolean {
    return this.code === "UNSUPPORTED_OPERATION";
  }
}
