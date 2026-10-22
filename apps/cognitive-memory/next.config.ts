import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The migrations travel with the deployment.
   *
   * They are read from the filesystem at runtime, by a path the bundler cannot
   * see: `migrationsFolder` in `src/server/db/client.ts` looks for them by
   * walking up from the working directory. The tracer usually finds them
   * anyway, but naming them here makes that a decision rather than an
   * accident — a deployment without them cannot apply the schema, and every
   * request that needs the database fails with "no such table".
   */
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**/*"]
  }
};

export default nextConfig;
