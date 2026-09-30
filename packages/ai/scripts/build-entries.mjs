import { build } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dts from "vite-plugin-dts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const external = [
  "ofetch",
  "@ai-sdk/openai-compatible",
  "@mastra/core",
  "@mastra/core/workflows",
  /^@mastra\/core\//,
  "ai",
  "zod",
  /^@ai-sdk\//,
  /^ai\//,
];

const entries = [
  { name: "index", file: "src/index.ts" },
  { name: "cursor/index", file: "src/cursor/index.ts" },
  { name: "workflows/index", file: "src/workflows/index.ts" },
  { name: "workflows/mastra/index", file: "src/workflows/mastra/index.ts" },
];

let first = true;
for (const entry of entries) {
  const outBase = entry.name;
  await build({
    plugins: first
      ? [
          dts({
            entryRoot: "src",
            outDir: "dist",
            tsconfigPath: "./tsconfig.json",
            rollupTypes: false,
          }),
        ]
      : [],
    build: {
      emptyOutDir: first,
      target: "es2022",
      sourcemap: true,
      minify: false,
      lib: {
        entry: resolve(root, entry.file),
        formats: ["es", "cjs"],
        fileName: (format) =>
          `${outBase}.${format === "cjs" ? "cjs" : "js"}`,
      },
      rollupOptions: {
        external,
        output: {
          inlineDynamicImports: true,
        },
      },
      outDir: "dist",
    },
  });
  console.log(`[build-entries] built dist/${outBase}.js`);
  first = false;
}
