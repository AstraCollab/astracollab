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
  /** The scope the key would have needed. */
  requiredScope: Schema.optional(Schema.String)
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  resource: Schema.String,
  id: Schema.String
}) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  /** Human-readable, and specific enough to fix the call. */
  message: Schema.String,
  /** Field path -> why it was rejected, when the failure is per-field. */
  issues: Schema.optional(Schema.Array(Schema.String))
}) {}

export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export class ModelFailure extends Schema.TaggedError<ModelFailure>()("ModelFailure", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export class BootstrapDisabled extends Schema.TaggedError<BootstrapDisabled>()(
  "BootstrapDisabled",
  {
    message: Schema.String
  }
) {}

/** The union handlers must handle exhaustively. */
export type CognitiveMemoryError =
  | Unauthorized
  | Forbidden
  | NotFound
  | InvalidRequest
  | StorageFailure
  | ModelFailure
  | BootstrapDisabled
