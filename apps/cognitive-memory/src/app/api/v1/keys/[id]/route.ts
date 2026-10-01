import { Effect } from "effect"

import { NotFound } from "@/server/domain/errors"
import { requireOrganization, respond } from "@/server/runtime"
import { Keys } from "@/server/services/keys"

/**
 * Revoke a key.
 *
 * Sets `revokedAt` rather than deleting the row, so an audit of "which key was
 * used at 3am" survives the fact that it has been turned off.
 */
export const dynamic = "force-dynamic"

const revoke = (_request: Request, context: RouteContext<"/api/v1/keys/[id]">) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const { id } = yield* Effect.promise(() => context.params)
    const keys = yield* Keys

    const revoked = yield* keys.revoke(organizationId, id)
    if (!revoked) {
      return yield* new NotFound({ resource: "api key", id })
    }
    return { id, revoked: true, revokedAt: new Date().toISOString() }
  })

export const DELETE = async (
  request: Request,
  context: RouteContext<"/api/v1/keys/[id]">
): Promise<Response> => respond(revoke(request, context))
