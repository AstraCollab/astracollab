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
        node: resolve(__dirname, "src/node.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "cjs" ? "cjs" : "js"}`,
    },
    rollupOptions: {
      external: ["ai", /^ai\//, "zod", /^node:/],
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
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
