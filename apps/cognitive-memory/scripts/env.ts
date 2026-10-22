import { resolve } from "node:path"
import { config } from "dotenv"

/**
 * The environment a script runs with.
 *
 * Next.js loads `.env` and `.env.local` for the app. A script under `scripts/`
 * is run by tsx, which loads nothing, so a script that reads the environment
 * sees none of it — and the first thing that breaks is the one that matters:
 * `pnpm db:migrate` migrates the local file the app falls back to, while the
 * deployment talks to Turso. The schema is applied in one place and looked for
 * in another, and nothing says so.
 *
 * The precedence is the one Next.js uses: a real environment variable wins,
 * then `.env.local`, then `.env`. dotenv never overwrites a variable that is
 * already set, so the file that wins has to be read first.
 */
export const loadEnv = (appDir: string = resolve(__dirname, "..")): void => {
  config({ path: resolve(appDir, ".env.local") })
  config({ path: resolve(appDir, ".env") })
}
