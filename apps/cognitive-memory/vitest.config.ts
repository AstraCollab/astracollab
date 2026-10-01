import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

/**
 * Vitest config.
 *
 * The `@` alias is resolved from the file URL rather than `process.cwd()`, for the
 * same reason the migrations folder is searched rather than hard-coded: the tests
 * have to resolve the same way whether they are run from the app, from the
 * workspace root, or from a CI runner.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
})
