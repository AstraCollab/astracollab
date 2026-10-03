import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: ["./src/server/db/schema.ts", "./src/server/db/auth-tables.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/nahcloud"
  },
  strict: true,
  verbose: true
})
