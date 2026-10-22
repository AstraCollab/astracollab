import { resolve } from "node:path"

/**
 * Where the database is, and how to open it.
 *
 * The service used to take a filesystem path and open it with better-sqlite3.
 * It now takes a URL, because the deployment that needed the change — a
 * serverless function on Vercel — has no filesystem worth writing to: the
 * bundle is read-only and the local disk is gone between invocations. Turso
 * answers over HTTP instead, so the address of the database is a URL rather
 * than a path.
 *
 * Three shapes are accepted and told apart by scheme, never by guessing:
 *
 *   libsql://cogmem-helixhex.aws-us-west-2.turso.io   a remote database
 *   file:.cognitive-memory/cognitive-memory.sqlite      a local file
 *   .cognitive-memory/cognitive-memory.sqlite           a local file, by path
 *
 * A bare path stays a path. That is what it has always been, and an operator
 * who set it should not have to change their deployment to upgrade the app.
 */

/** Schemes that mean "the database is somewhere else". */
const REMOTE_SCHEMES = ["libsql://", "https://", "http://", "wss://", "ws://"]

/** The default: a SQLite file beside the app, created on first connection. */
export const DEFAULT_DATABASE_PATH = ".cognitive-memory/cognitive-memory.sqlite"

/** A Turso or other remote database, reached over the network. */
export const isRemoteDatabaseUrl = (url: string): boolean => {
  const lower = url.toLowerCase()
  return REMOTE_SCHEMES.some((scheme) => lower.startsWith(scheme))
}

/**
 * The file a `file:` URL points at, or null when there is no file to point at.
 *
 * The parent directory has to exist before the client opens the file, because
 * the client creates the file but not the directory holding it — the same gap
 * better-sqlite3 had, and the reason for the `mkdir` in `./client`.
 */
export const localDatabasePath = (url: string): string | null => {
  if (!url.toLowerCase().startsWith("file:")) return null
  const path = url.slice("file:".length)
  if (path === ":memory:" || path.startsWith(":memory:?")) return null
  return path
}

/**
 * The URL the client is opened with.
 *
 * A bare path becomes an absolute `file:` URL. The libsql client opens local
 * files relative to the process, and a bundled serverless function does not
 * necessarily run from the directory the path was written for — an absolute
 * path removes the question.
 */
export const toDatabaseUrl = (raw: string): string => {
  const value = raw.trim()
  if (value === "") return `file:${resolve(DEFAULT_DATABASE_PATH)}`
  if (value === ":memory:") return "file::memory:"
  if (value.toLowerCase().startsWith("file:")) return value
  if (isRemoteDatabaseUrl(value)) return value
  return `file:${resolve(value)}`
}

/**
 * The token a remote database is reached with.
 *
 * Turso's own name for it comes first, because that is what the Turso CLI
 * writes into a `.env` and what a deployment copied from one will have.
 */
export const readDatabaseAuthToken = (env: Record<string, string | undefined>): string | null =>
  env.COGNITIVE_MEMORY_DATABASE_AUTH_TOKEN?.trim() ||
  env.TURSO_AUTH_TOKEN?.trim() ||
  env.DATABASE_AUTH_TOKEN?.trim() ||
  null
