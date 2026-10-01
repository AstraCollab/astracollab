import { Effect } from "effect"

import { IssueKeyBody } from "@/server/domain/api"
import { InvalidRequest } from "@/server/domain/errors"
import { decodeBody, readJson } from "@/server/http/respond"
import { requireOrganization, respond } from "@/server/runtime"
import { Keys, Scope } from "@/server/services/keys"

/**
 * Key management.
 *
 * Authenticated by **session cookie**, not by API key. That is the whole point:
 * keys are how a caller escalates, so minting one must require the human. A
 * `keys:manage` key can rotate siblings for its own organisation (the CI case),
 * but it cannot create a new organisation and cannot widen its own scopes.
 *
 * The full secret is returned exactly once, here. Only its sha256 is stored, so
 * this response is the last chance to copy it.
 */
export const dynamic = "force-dynamic"

const DEFAULT_SCOPES: ReadonlyArray<string> = [Scope.Read, Scope.Write, Scope.Stats]

const list = Effect.gen(function* () {
  const { organizationId } = yield* requireOrganization
  const keys = yield* Keys
  const rows = yield* keys.list(organizationId)
  return {
    organizationId,
    keys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
      expiresAt: row.expiresAt,
      status:
        row.revokedAt !== null
          ? ("revoked" as const)
          : row.expiresAt !== null && new Date(row.expiresAt).getTime() < Date.now()
            ? ("expired" as const)
            : ("active" as const)
    }))
  }
})

const issue = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const body = yield* decodeBody(IssueKeyBody, yield* Effect.promise(() => readJson(request)))
    const keys = yield* Keys

    const scopes = body.scopes ?? DEFAULT_SCOPES
    if (scopes.includes(Scope.ManageKeys) && scopes.length === 1) {
      return yield* new InvalidRequest({
        message: "A key with only keys:manage can rotate keys but cannot read or write memory."
      })
    }

    const created = yield* keys.issue({
      organizationId,
      name: body.name,
      scopes,
      ...(body.expiresInDays === undefined ? {} : { expiresInDays: body.expiresInDays })
    })

    return {
      // Shown once. The server cannot show it again.
      key: created.secret,
      id: created.id,
      prefix: created.prefix,
      scopes: created.scopes,
      expiresAt: created.expiresAt,
      warning: "Copy this now. Only a hash is stored, so it cannot be recovered."
    }
  })

export const GET = async (): Promise<Response> => respond(list)

export const POST = async (request: Request): Promise<Response> =>
  respond(issue(request), { status: 201 })
