import { organization } from "better-auth/plugins"
import { apiKey } from "@better-auth/api-key"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/pg-proxy"

import * as authTables from "../src/server/db/auth-tables"

/**
 * Config for the schema generator only — never imported by the running app.
 *
 * Separate from `src/server/auth/better-auth.ts` to break a bootstrap cycle: the
 * real config hands its Drizzle tables to the adapter, and those tables are the
 * very file the generator is about to write.
 *
 * A `pg-proxy` driver stands in for a real connection. The generator reads the auth
 * *shape* and never queries, but rejects the built-in `memory` adapter as
 * "not supported" — and `pg-proxy` is pure JS, so unlike `postgres.js` (ESM-only;
 * this config loads in CJS via `jiti`) it loads here.
 *
 * Keep the plugins below in lockstep with `src/server/auth/better-auth.ts`: this
 * file decides the generated tables, that one decides the runtime.
 */
export const auth = betterAuth({
  baseURL: "http://localhost:3000",
  secret: "generator-only-this-never-reaches-a-table-definition-000000",
  database: drizzleAdapter(
    drizzle(async () => ({ rows: [] }), { schema: authTables, casing: "snake_case" }),
    { provider: "pg" }
  ),
  emailAndPassword: { enabled: true },
  plugins: [
    organization({ allowUserToCreateOrganization: true, organizationLimit: 20 }),
    apiKey([
      { configId: "agent", defaultPrefix: "nah_agent_", references: "organization" },
      {
        configId: "runner",
        defaultPrefix: "nah_run_",
        references: "organization",
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 }
      }
    ])
  ]
})
