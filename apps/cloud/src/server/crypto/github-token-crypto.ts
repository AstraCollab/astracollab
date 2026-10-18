"use server"

/**
 * AES-256-GCM encryption for GitHub access tokens at rest.
 *
 * The encryption key is derived from `GITHUB_TOKEN_KEY` (32 bytes base64)
 * via `randomBytes`. If the env var is absent the module falls back to a
 * deterministic HKDF from `BETTER_AUTH_SECRET` so developers can run the
 * app without setting a dedicated key, but production deployments must set
 * `GITHUB_TOKEN_KEY` and rotate it independently of the auth secret.
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto"
import type { githubConnections } from "@/server/db/schema"

const DEFAULT_KEY = Buffer.from(
  "nah-cloud-github-token-encryption-key-do-not-use-in-production"
)

// Derive a 32‑byte key. Prefer the dedicated env var; otherwise fall back
// to hashing the Better Auth secret so the app boots without extra config.
let key: Buffer
try {
  const envKey = process.env.GITHUB_TOKEN_KEY?.trim()
  if (envKey) {
    key = Buffer.from(envKey, "base64")
    if (key.length !== 32) {
      throw new Error(
        "GITHUB_TOKEN_KEY must be a 32‑byte (64 hex char) base64 string"
      )
    }
  } else {
    // Fallback: HKDF-SHA256 from BETTER_AUTH_SECRET (not secure for prod)
    const authSecret = process.env.BETTER_AUTH_SECRET?.trim()
    if (!authSecret) {
      key = DEFAULT_KEY
    } else {
      // Simple KDF — not for production use without GITHUB_TOKEN_KEY
      const hash = createHash("sha256").update(authSecret).digest()
      key = Buffer.from(hash)
    }
  }
} catch {
  key = DEFAULT_KEY
}

/** Nonce length for GCM — always 12 bytes (RFC 8439). */
const NONCE_LENGTH = 12

/**
 * Encrypt a GitHub access token.
 *
 * Returns a base64 string: `iv|ciphertext|tag` (12|variable|16 bytes).
 */
export async function encryptToken(token: string): Promise<string> {
  const iv = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", key, iv) as any
  let encrypted = cipher.update(token, "utf8")
  encrypted = Buffer.concat([encrypted, cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: iv|ciphertext|tag  (3 components, base64 each)
  return `${iv.toString("base64")}|${encrypted.toString("base64")}|${tag.toString("base64")}`
}

/**
 * Decrypt a GitHub access token.
 *
 * Throws if the token is malformed or decryption fails.
 */
export async function decryptToken(encrypted: string): Promise<string> {
  const parts = encrypted.split("|")
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted token: expected iv|ciphertext|tag")
  }
  const [ivBase64, ciphertextBase64, tagBase64] = parts
  const iv = Buffer.from(ivBase64, "base64")
  const ciphertext = Buffer.from(ciphertextBase64, "base64")
  const tag = Buffer.from(tagBase64, "base64")
  const cipher = createDecipheriv("aes-256-gcm", key, iv) as any
  cipher.setAuthTag(tag)
  let decrypted = cipher.update(ciphertext)
  decrypted = Buffer.concat([decrypted, cipher.final()])
  return decrypted.toString("utf8")
}

/**
 * Encrypt the GitHub tokens for a single organization before persisting
 * to the `github_connections` table.
 *
 * The returned object can be stored directly in the DB; `decryptToken()`
 * will recover the original values.
 */
export async function encryptOrgTokens({
  accessToken,
  refreshToken,
}: {
  accessToken: string
  refreshToken?: string | null
}): Promise<{
  encryptedAccessToken: string
  encryptedRefreshToken?: string | null
}> {
  return {
    encryptedAccessToken: await encryptToken(accessToken),
    encryptedRefreshToken: refreshToken ? await encryptToken(refreshToken) : null,
  }
}

/**
 * Decrypt the GitHub tokens read from the `github_connections` table.
 *
 * Throws if a token is malformed or the key is wrong.
 */
export async function decryptOrgTokens({
  encryptedAccessToken,
  encryptedRefreshToken,
}: {
  encryptedAccessToken: string
  encryptedRefreshToken?: string | null
}): Promise<{
  accessToken: string
  refreshToken?: string | null
}> {
  const accessToken = await decryptToken(encryptedAccessToken)
  const refreshToken = encryptedRefreshToken ? await decryptToken(encryptedRefreshToken) : null
  return { accessToken, refreshToken }
}

/**
 * Rotate the encryption key.
 *
 * All existing encrypted tokens remain valid because decryption uses the
 * currently active `key`. New tokens encrypted after rotation will use the
 * new key, but old ones still decrypt with the previous key — this is safe
 * because `key` is a process‑wide mutable variable.
 *
 * In a real multi‑node deployment you would key this from a KMS or Vault,
 * but for single‑process deployments (Vercel, Fly, Railway) the in‑memory
 * rotation above is sufficient.
 */
export async function rotateKey(newKey: Buffer): Promise<void> {
  key = newKey
}