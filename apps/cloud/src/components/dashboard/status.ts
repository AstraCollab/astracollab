import type { BadgeTone } from "@/components/ui/badge"
import type { SandboxStatus, SpanStatus } from "@/server/db/schema"
import type { RunStatus } from "@/server/domain/errors"

/**
 * Status words, coloured once.
 *
 * Every list in the dashboard renders a status, and three of them have to agree:
 * a run that says `running` here and `queued` on the sandboxes page is worse than
 * having no colour at all, because the reader has to reconcile two vocabularies
 * instead of trusting one.
 *
 * `cancelled` is `neutral` rather than `bad`. Nothing went wrong; a human stopped
 * it, and painting that red alongside `failed` conflates an intentional action
 * with a fault.
 */
export const runTone = (status: RunStatus): BadgeTone => {
  switch (status) {
    case "running":
      return "busy"
    case "succeeded":
      return "good"
    case "failed":
      return "bad"
    case "cancelled":
      return "neutral"
    default:
      return "neutral"
  }
}

export const sandboxTone = (status: SandboxStatus): BadgeTone => {
  switch (status) {
    case "running":
      return "busy"
    case "stopped":
      return "warn"
    case "destroyed":
      return "neutral"
    default:
      return "neutral"
  }
}

/**
 * Trace outcomes.
 *
 * `interrupted` is `warn`, not `bad`, and the distinction is the same one
 * `cancelled` gets above: a trace stops because a deploy restarted the worker or
 * a user hit stop. That is not a fault in the agent, and colouring it the same as
 * an `error` would bury real failures under runs that merely got cut off.
 */
export const traceTone = (status: SpanStatus): BadgeTone => {
  switch (status) {
    case "ok":
      return "good"
    case "error":
      return "bad"
    case "interrupted":
      return "warn"
    default:
      return "neutral"
  }
}
