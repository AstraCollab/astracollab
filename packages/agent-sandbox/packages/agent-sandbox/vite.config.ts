import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        errors: resolve(__dirname, "src/errors.ts"),
        "helpers/index": resolve(__dirname, "src/helpers/index.ts"),
        "adapters/mastra/index": resolve(__dirname, "src/adapters/mastra/index.ts"),
        "adapters/nah/index": resolve(__dirname, "src/adapters/nah/index.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "cjs" ? "cjs" : "js"}`,
    },
    rollupOptions: {
      external: [
        "ofetch",
        "@mastra/core",
        "@mastra/core/workspace",
        /^@mastra\/core\//,
        "@astracollab/not-another-harness",
        "@astracollab/not-another-harness/node",
        "@blaxel/core",
        "zod",
        "node:fs",
        "node:path",
        "node:path/posix",
        "node:crypto",
      ],
      output: {
        preserveModules: false,
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
});
