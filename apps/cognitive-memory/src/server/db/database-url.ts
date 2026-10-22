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

/**
 * Schemes that mean "the database is somewhere else".
 *
 * By name, not by prefix. `libsql://` and `turso://` are two spellings of the
 * same address, and an address that matches neither exactly — a `turso://` URL
 * from an older CLI, say — still has to be recognised as a URL. An address that
 * is not recognised falls through to the path handling, and a URL read as a
 * path becomes a directory named after the host of a database that is somewhere
 * else entirely.
 */
const REMOTE_SCHEMES = ["libsql", "turso", "https", "http", "wss", "ws"]

/** The default: a SQLite file beside the app, created on first connection. */
export const DEFAULT_DATABASE_PATH = ".cognitive-memory/cognitive-memory.sqlite"

/**
 * The scheme of an address, lower-cased, or null when it has none.
 *
 * This is what tells a URL from a path: `libsql://…` names a database reached
 * over the network, `.cognitive-memory/cognitive-memory.sqlite` names a file on
 * this machine, and only the second has a directory to create.
 *
 * A single letter is not a scheme — it is a drive letter, and `C:\…` is a path
 * on Windows rather than a URL.
 */
const schemeOf = (url: string): string | null => {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())
  if (match === null) return null
  if (match[1].length === 1) return null
  return match[1].toLowerCase()
}

/** A Turso or other remote database, reached over the network. */
export const isRemoteDatabaseUrl = (url: string): boolean => {
  const scheme = schemeOf(url)
  return scheme !== null && REMOTE_SCHEMES.includes(scheme)
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
  // A `file:` URL whose path is another URL is a mistake, not a file. Refusing
  // it here keeps the mistake from becoming a directory named after the host
  // of a remote database.
  if (schemeOf(path) !== null) return null
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
 * The address the environment names, before it is turned into a client URL.
 *
 * A URL wins over a path, whichever name it comes under: `DATABASE_URL` is how
 * a platform says "this deployment has a remote database", and it must not lose
 * to a local path left over in a copied `.env.local`. Only when no URL is set
 * at all does the path apply, and only then is the default file used.
 */
export const readDatabaseUrl = (env: Record<string, string | undefined>): string =>
  env.COGNITIVE_MEMORY_DATABASE_URL?.trim() ||
  env.DATABASE_URL?.trim() ||
  env.COGNITIVE_MEMORY_DATABASE_PATH?.trim() ||
  DEFAULT_DATABASE_PATH

/**
 * The URL the client is opened with, read from the environment.
 *
 * One resolver, used by the app, by the scripts under `scripts/` and by the
 * Drizzle Kit configuration: three places that read the same environment have
 * to end up at the same database, or a migration lands in one and the app looks
 * for the schema in another.
 */
export const resolveDatabaseUrl = (env: Record<string, string | undefined>): string =>
  toDatabaseUrl(readDatabaseUrl(env))

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

/**
 * The token carried by the address itself.
 *
 * The Turso CLI prints a URL with the token in it — `libsql://db.turso.io?authToken=…` —
 * and pasting that whole string is the path of least resistance. The driver
 * understands it; the address is parsed here as well, so the app knows a token
 * exists and does not report a missing one.
 */
export const authTokenInUrl = (url: string): string | null => {
  const mark = url.indexOf("?")
  if (mark === -1) return null
  for (const pair of url.slice(mark + 1).split("&")) {
    const separator = pair.indexOf("=")
    const key = separator === -1 ? pair : pair.slice(0, separator)
    if (key !== "authToken") continue
    const value = separator === -1 ? "" : decodeURIComponent(pair.slice(separator + 1)).trim()
    return value === "" ? null : value
  }
  return null
}

/**
 * The token to reach this database with: the environment first, then the
 * address.
 *
 * The environment wins because a deployment that names the token separately has
 * said which token it means, and an address copied out of a dashboard may carry
 * an old one.
 */
export const resolveDatabaseAuthToken = (
  env: Record<string, string | undefined>,
  url: string
): string | null => readDatabaseAuthToken(env) ?? authTokenInUrl(url)
