import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        context: resolve(__dirname, "src/context.ts"),
        engine: resolve(__dirname, "src/engine.ts"),
        errors: resolve(__dirname, "src/errors.ts"),
        "helpers/files": resolve(__dirname, "src/helpers/files.ts"),
        "model-types": resolve(__dirname, "src/model-types.ts"),
        "resources/files": resolve(__dirname, "src/resources/files.ts"),
        schema: resolve(__dirname, "src/schema.ts"),
        "queries/index": resolve(__dirname, "src/queries/index.ts"),
        "queries/files": resolve(__dirname, "src/queries/files.ts"),
        "mutators/client": resolve(__dirname, "src/mutators/client.ts"),
        "mutators/server": resolve(__dirname, "src/mutators/server.ts"),
        types: resolve(__dirname, "src/types.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "cjs" ? "cjs" : "js"}`,
    },
    rollupOptions: {
      external: ["@rocicorp/zero", "zod"],
      output: {
        manualChunks: undefined,
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
