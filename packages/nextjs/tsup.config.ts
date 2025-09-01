import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ["react", "react-dom", "next", "axios", "uuid"]
  },
  {
    entry: ["src/upload-service/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    external: ["react", "react-dom", "next", "axios", "uuid"]
  },
  {
    entry: ["src/hooks/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    external: ["react", "react-dom", "next", "axios", "uuid"]
  },
  {
    entry: ["src/components/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    external: ["react", "react-dom", "next", "axios", "uuid"]
  }
]);
