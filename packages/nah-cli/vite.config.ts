import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("./package.json") as {
  version: string;
};

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: false,
    minify: true,
    emptyOutDir: true,
    lib: {
      entry: {
        cli: resolve(__dirname, "src/cli.ts"),
      },
      formats: ["es"],
      fileName: () => "cli.js",
    },
    rollupOptions: {
      external: [/^node:/, "@astracollab/not-another-harness", "@blaxel/core"],
      output: {
        // Providers are lazy-imported; the banner makes dist/cli.js executable.
        banner: "#!/usr/bin/env node",
      },
    },
  },
  plugins: [
    dts({
      entryRoot: "src",
      outDir: "dist",
      tsconfigPath: "./tsconfig.json",
      rollupTypes: false,
    }),
  ],
  define: {
    __NAH_VERSION__: JSON.stringify(version),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
