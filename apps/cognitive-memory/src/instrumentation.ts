/**
 * Startup.
 *
 * The database is prepared here — pragmas, then the pending migrations —
 * because the deployment this was written for has no filesystem to prepare: a
 * serverless function on Vercel cannot write a SQLite file, so the database is
 * a Turso database reached over HTTP, and a migration is a promise rather than
 * a statement.
 *
 * Next.js awaits `register` before the server accepts a request, so by the
 * time anything is served the schema is in place. That matters for the first
 * request of a fresh deployment, which is usually `sign-up`: without it the
 * request fails with "no such table: user", which reads as a broken app rather
 * than an unrun migration.
 *
 * The work is idempotent — drizzle skips whatever the `__drizzle_migrations`
 * table already records — so a warm instance pays one read and a cold one
 * applies what is missing.
 *
 * A failure is warned about rather than thrown. The server has to come up even
 * when the database is not there: the route that needs the database answers
 * with the reason, and a deployment that is one missing variable away from
 * working should say so rather than fail as an opaque 500.
 *
 * The import is inside the guard because the driver is a Node module: the Edge
 * runtime has no filesystem, and a static import would drag the whole client
 * into an Edge bundle that cannot load it.
 */
export const register = async (): Promise<void> => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { prepareDb } = await import("./server/db/client")
    try {
      await prepareDb()
    } catch (error) {
      // The server still comes up. A database that is unreachable, or one
      // whose token was never set, is reported by the route that needs it — a
      // 503 that says why — and by the health endpoint. Crashing here instead
      // would replace that with an opaque 500 and take every other route down
      // with it.
      process.emitWarning(
        `cognitive-memory: the database could not be prepared at startup: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}
