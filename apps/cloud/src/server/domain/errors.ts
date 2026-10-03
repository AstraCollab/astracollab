import { Schema } from "effect"

/**
 * Every failure a client can provoke, as a tagged error.
 *
 * The point of tagging them is the HTTP edge: a handler maps `_tag` to a status
 * code in one place (`src/server/http/respond.ts`) instead of each route
 * remembering what "not found" is worth. Anything *not* in this file is a bug or
 * an outage, and surfaces as a 500 with the cause logged rather than a tidy
 * 400 that would hide it.
 */

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  /** Safe to show the caller; explains which header or header format is wrong. */
  message: Schema.String
}) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
  /** The scope the token would have needed. */
  requiredScope: Schema.optional(Schema.String)
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  resource: Schema.String,
  id: Schema.String
}) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  message: Schema.String,
  issues: Schema.optional(Schema.Array(Schema.String))
}) {}

export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The Durable Object refused to start, or refused to keep running. */
export class SandboxFailure extends Schema.TaggedError<SandboxFailure>()("SandboxFailure", {
  operation: Schema.String,
  sandboxId: Schema.String,
  cause: Schema.Defect()
}) {}

export class BillingRequired extends Schema.TaggedError<BillingRequired>()("BillingRequired", {
  message: Schema.String
}) {}

/**
 * A run's lifecycle.
 *
 * `queued` -> `running` -> a terminal state. The terminal split between
 * `succeeded` and `failed` is by exit code, decided by the sandbox, not by
 * whether an error message exists: an agent that fails to find its own bug
 * exits non-zero and says nothing, and treating silence as success would bill
 * a broken run as a good one.
 */
export const RunStatus = Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"])
export type RunStatus = typeof RunStatus.Type

export type CloudError =
  | Unauthorized
  | Forbidden
  | NotFound
  | InvalidRequest
  | StorageFailure
  | SandboxFailure
  | BillingRequired