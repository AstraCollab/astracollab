import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer, Redacted } from "effect"

import { Forbidden, StorageFailure, Unauthorized } from "../domain/errors"
import { MemoryStore } from "./memory-store"

/**
 * Machine credentials.
 *
 * Better Auth owns who a human is; this owns what an agent presents. Better Auth
 * 1.7 ships no API-key plugin, and its session cookie is the wrong shape for an
 * agent anyway — a credential that expires mid-run and cannot be scoped to
 * read-only is not a service credential. So keys stay here: opaque, revocable,
 * scope-limited, and independent of a browser.
 *
 * A key is `cmi_<env>_<id>_<secret>`. The prefix is public and indexed; the
 * secret is 32 random bytes shown exactly once; only its sha256 is stored.
 *
 * sha256 rather than a slow KDF, deliberately. Password hashing exists to make
 * guessing a *human* password expensive. Here the secret has 256 bits of
 * entropy, so there is no search to slow down, and a deliberately slow hash
 * would add latency to every request to protect against an attack that cannot
 * happen.
 */

export const Scope = {
  Read: "memories:read",
  Write: "memories:write",
  Stats: "stats:read",
  /** Mint and revoke other keys for the same organisation. */
  ManageKeys: "keys:manage"
} as const

export const ALL_SCOPES: ReadonlyArray<string> = [Scope.Read, Scope.Write, Scope.Stats, Scope.ManageKeys]

const KEY_PATTERN = /^cmi_([a-z]+)_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

/** Constant-time compare, so a wrong secret cannot be found a byte at a time. */
const matches = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

const environment = (): string => {
  const explicit = process.env.COGNITIVE_MEMORY_ENV?.trim()
  if (explicit) return explicit.toLowerCase()
  return process.env.NODE_ENV === "production" ? "prod" : "dev"
}

export interface IssuedKey {
  /** The only moment the full key exists. Store it now or not at all. */
  readonly secret: string
  readonly id: string
  readonly prefix: string
  readonly organizationId: string
  readonly name: string
  readonly scopes: ReadonlyArray<string>
  readonly createdAt: string
  readonly expiresAt: string | null
}

export interface Caller {
  readonly organizationId: string
  readonly keyId: string
  readonly scopes: ReadonlyArray<string>
}

export interface KeyService {
  /**
   * Resolve a presented key to the organisation it may read and write.
   *
   * Failures are deliberately indistinguishable in wording, and the prefix
   * lookup happens before any hash comparison so a rejected key costs one
   * indexed read either way.
   */
  readonly authenticate: (presented: string | null) => Effect.Effect<Caller, Unauthorized | StorageFailure>

  /** Mint a key. The returned secret is not recoverable afterwards. */
  readonly issue: (input: {
    readonly organizationId: string
    readonly name: string
    readonly scopes: ReadonlyArray<string>
    readonly expiresInDays?: number | undefined
  }) => Effect.Effect<IssuedKey, Forbidden | StorageFailure>

  readonly list: (
    organizationId: string
  ) => Effect.Effect<
    Array<{
      readonly id: string
      readonly name: string
      readonly prefix: string
      readonly scopes: ReadonlyArray<string>
      readonly lastUsedAt: string | null
      readonly revokedAt: string | null
      readonly expiresAt: string | null
      readonly createdAt: string
    }>,
    StorageFailure
  >

  readonly revoke: (organizationId: string, id: string) => Effect.Effect<boolean, StorageFailure>
}

export class Keys extends Context.Service<Keys, KeyService>()("cognitive-memory/Keys") {
  static readonly layer = Layer.effect(
    Keys,
    Effect.gen(function* () {
      const store = yield* MemoryStore

      const issue: KeyService["issue"] = (input) =>
        Effect.gen(function* () {
          if (input.scopes.length === 0) {
            return yield* new Forbidden({ message: "A key needs at least one scope." })
          }
          const unknown = input.scopes.filter((scope) => !ALL_SCOPES.includes(scope))
          if (unknown.length > 0) {
            return yield* new Forbidden({
              message: `Unknown scope(s): ${unknown.join(", ")}. Valid scopes: ${ALL_SCOPES.join(", ")}.`
            })
          }
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          const id = randomBytes(4).toString("hex")
          const secret = randomBytes(32).toString("base64url")
          const prefix = `cmi_${environment()}_${id}`
          const expiresAt =
            input.expiresInDays === undefined ? null : new Date(now + input.expiresInDays * 86_400_000).toISOString()

          yield* store.createKey({
            id,
            organizationId: input.organizationId,
            name: input.name,
            prefix,
            secretHash: sha256(secret),
            scopes: input.scopes,
            now,
            ...(expiresAt === null ? {} : { expiresAt })
          })

          return {
            secret: `${prefix}_${secret}`,
            id,
            prefix,
            organizationId: input.organizationId,
            name: input.name,
            scopes: input.scopes,
            createdAt: new Date(now).toISOString(),
            expiresAt
          }
        })

      const authenticate: KeyService["authenticate"] = (presented) =>
        Effect.gen(function* () {
          if (presented === null || presented.trim() === "") {
            return yield* new Unauthorized({
              message: "Missing credentials. Send `Authorization: Bearer <api key>`."
            })
          }
          const value = presented.trim()
          const parsed = KEY_PATTERN.exec(value)
          if (!parsed) {
            return yield* new Unauthorized({ message: "Malformed API key. Expected cmi_<env>_<id>_<secret>." })
          }

          const stored = yield* store.findKeyByPrefix(`cmi_${parsed[1]}_${parsed[2]}`)
          if (!stored) {
            return yield* new Unauthorized({ message: "Unknown API key." })
          }
          if (stored.revokedAt !== null) {
            return yield* new Unauthorized({ message: "This API key has been revoked." })
          }
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          if (stored.expiresAt !== null && new Date(stored.expiresAt).getTime() <= now) {
            return yield* new Unauthorized({ message: "This API key has expired." })
          }
          if (!matches(sha256(parsed[3]), stored.secretHash)) {
            return yield* new Unauthorized({ message: "Invalid API key." })
          }

          yield* store.markKeyUsed(stored.id, now)
          return { organizationId: stored.organizationId, keyId: stored.id, scopes: stored.scopes }
        })

      const list: KeyService["list"] = (organizationId) => store.listKeys(organizationId)

      const revoke: KeyService["revoke"] = (organizationId, id) =>
        Effect.gen(function* () {
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          return yield* store.revokeKey(organizationId, id, now)
        })

      return Keys.of({ authenticate, issue, list, revoke })
    })
  )
}

/**
 * Fail unless the caller holds a scope.
 *
 * A 403 naming the missing scope, not a 401 that would send the caller hunting
 * for a typo in a key that is perfectly valid.
 */
export const requireScope = (caller: Caller, scope: string): Effect.Effect<void, Forbidden> =>
  caller.scopes.includes(scope)
    ? Effect.void
    : Effect.fail(
        new Forbidden({ message: `This key lacks the ${scope} scope.`, requiredScope: scope })
      )

/** Redacted for logging: never print a whole key. */
export const redactKey = (value: string): Redacted.Redacted<string> =>
  Redacted.make(`${value.slice(0, 14)}…`)
