import { execFileSync } from "node:child_process"

/**
 * Regenerate the Better Auth Drizzle schema.
 *
 * Wrapped in a script so the invocation lives in package.json rather than in
 * someone's shell history: the CLI version is pinned here for a reason. The
 * CLI versions separately from the library, and a newer CLI generating a schema
 * for an older runtime is how a migration ends up with a column nothing reads.
 */
execFileSync(
  "npx",
  ["--yes", "@better-auth/cli@1.4.22", "generate", "--config", "src/server/auth/better-auth.ts", "--output", "src/server/db/auth-schema.ts", "--yes"],
  { stdio: "inherit" }
)
