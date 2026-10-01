// vite.config.ts
import { defineConfig } from "file:///Users/elias/Documents/Code/astracollab/astracollab-packages/node_modules/.pnpm/vite@5.4.21_@types+node@22.19.9_less@4.4.1_lightningcss@1.32.0_sass@1.77.4_terser@5.43.1/node_modules/vite/dist/node/index.js";
import dts from "file:///Users/elias/Documents/Code/astracollab/astracollab-packages/node_modules/.pnpm/vite-plugin-dts@4.5.4_@types+node@22.19.9_rollup@4.49.0_typescript@5.9.2_vite@5.4.21_@t_a067a1ac4a6b5dc49f1705e06e4459be/node_modules/vite-plugin-dts/dist/index.mjs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
var __vite_injected_original_dirname = "/Users/elias/Documents/Code/astracollab/astracollab-packages/packages/nah";
var __vite_injected_original_import_meta_url = "file:///Users/elias/Documents/Code/astracollab/astracollab-packages/packages/nah/vite.config.ts";
var { version } = createRequire(__vite_injected_original_import_meta_url)("./package.json");
var vite_config_default = defineConfig({
  build: {
    target: "es2022",
    sourcemap: false,
    minify: true,
    emptyOutDir: true,
    lib: {
      entry: {
        cli: resolve(__vite_injected_original_dirname, "src/cli.ts")
      },
      formats: ["es"],
      fileName: () => "cli.js"
    },
    rollupOptions: {
      // pi-tui reaches for node:child_process (it can shell out for its
      // autocomplete provider) and ships native clipboard prebuilds, so it must
      // stay a real runtime dependency rather than being inlined into the CLI
      // bundle. It is declared in `dependencies`, so npm installs it.
      external: [/^node:/, "@astracollab/not-another-harness", "@blaxel/core", "@earendil-works/pi-tui"],
      output: {
        // Providers are lazy-imported; the banner makes dist/cli.js executable.
        banner: "#!/usr/bin/env node"
      }
    }
  },
  plugins: [
    dts({
      entryRoot: "src",
      outDir: "dist",
      tsconfigPath: "./tsconfig.json",
      rollupTypes: false
    })
  ],
  define: {
    __NAH_VERSION__: JSON.stringify(version)
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvZWxpYXMvRG9jdW1lbnRzL0NvZGUvYXN0cmFjb2xsYWIvYXN0cmFjb2xsYWItcGFja2FnZXMvcGFja2FnZXMvbmFoXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvZWxpYXMvRG9jdW1lbnRzL0NvZGUvYXN0cmFjb2xsYWIvYXN0cmFjb2xsYWItcGFja2FnZXMvcGFja2FnZXMvbmFoL3ZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9lbGlhcy9Eb2N1bWVudHMvQ29kZS9hc3RyYWNvbGxhYi9hc3RyYWNvbGxhYi1wYWNrYWdlcy9wYWNrYWdlcy9uYWgvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IGR0cyBmcm9tIFwidml0ZS1wbHVnaW4tZHRzXCI7XG5pbXBvcnQgeyByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuXG5jb25zdCB7IHZlcnNpb24gfSA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKShcIi4vcGFja2FnZS5qc29uXCIpIGFzIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xufTtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgYnVpbGQ6IHtcbiAgICB0YXJnZXQ6IFwiZXMyMDIyXCIsXG4gICAgc291cmNlbWFwOiBmYWxzZSxcbiAgICBtaW5pZnk6IHRydWUsXG4gICAgZW1wdHlPdXREaXI6IHRydWUsXG4gICAgbGliOiB7XG4gICAgICBlbnRyeToge1xuICAgICAgICBjbGk6IHJlc29sdmUoX19kaXJuYW1lLCBcInNyYy9jbGkudHNcIiksXG4gICAgICB9LFxuICAgICAgZm9ybWF0czogW1wiZXNcIl0sXG4gICAgICBmaWxlTmFtZTogKCkgPT4gXCJjbGkuanNcIixcbiAgICB9LFxuICAgIHJvbGx1cE9wdGlvbnM6IHtcbiAgICAgIC8vIHBpLXR1aSByZWFjaGVzIGZvciBub2RlOmNoaWxkX3Byb2Nlc3MgKGl0IGNhbiBzaGVsbCBvdXQgZm9yIGl0c1xuICAgICAgLy8gYXV0b2NvbXBsZXRlIHByb3ZpZGVyKSBhbmQgc2hpcHMgbmF0aXZlIGNsaXBib2FyZCBwcmVidWlsZHMsIHNvIGl0IG11c3RcbiAgICAgIC8vIHN0YXkgYSByZWFsIHJ1bnRpbWUgZGVwZW5kZW5jeSByYXRoZXIgdGhhbiBiZWluZyBpbmxpbmVkIGludG8gdGhlIENMSVxuICAgICAgLy8gYnVuZGxlLiBJdCBpcyBkZWNsYXJlZCBpbiBgZGVwZW5kZW5jaWVzYCwgc28gbnBtIGluc3RhbGxzIGl0LlxuICAgICAgZXh0ZXJuYWw6IFsvXm5vZGU6LywgXCJAYXN0cmFjb2xsYWIvbm90LWFub3RoZXItaGFybmVzc1wiLCBcIkBibGF4ZWwvY29yZVwiLCBcIkBlYXJlbmRpbC13b3Jrcy9waS10dWlcIl0sXG4gICAgICBvdXRwdXQ6IHtcbiAgICAgICAgLy8gUHJvdmlkZXJzIGFyZSBsYXp5LWltcG9ydGVkOyB0aGUgYmFubmVyIG1ha2VzIGRpc3QvY2xpLmpzIGV4ZWN1dGFibGUuXG4gICAgICAgIGJhbm5lcjogXCIjIS91c3IvYmluL2VudiBub2RlXCIsXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG4gIHBsdWdpbnM6IFtcbiAgICBkdHMoe1xuICAgICAgZW50cnlSb290OiBcInNyY1wiLFxuICAgICAgb3V0RGlyOiBcImRpc3RcIixcbiAgICAgIHRzY29uZmlnUGF0aDogXCIuL3RzY29uZmlnLmpzb25cIixcbiAgICAgIHJvbGx1cFR5cGVzOiBmYWxzZSxcbiAgICB9KSxcbiAgXSxcbiAgZGVmaW5lOiB7XG4gICAgX19OQUhfVkVSU0lPTl9fOiBKU09OLnN0cmluZ2lmeSh2ZXJzaW9uKSxcbiAgfSxcbiAgdGVzdDoge1xuICAgIGVudmlyb25tZW50OiBcIm5vZGVcIixcbiAgICBpbmNsdWRlOiBbXCJ0ZXN0LyoqLyoudGVzdC50c1wiXSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUE2WSxTQUFTLG9CQUFvQjtBQUMxYSxPQUFPLFNBQVM7QUFDaEIsU0FBUyxlQUFlO0FBQ3hCLFNBQVMscUJBQXFCO0FBSDlCLElBQU0sbUNBQW1DO0FBQWlOLElBQU0sMkNBQTJDO0FBSzNTLElBQU0sRUFBRSxRQUFRLElBQUksY0FBYyx3Q0FBZSxFQUFFLGdCQUFnQjtBQUluRSxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixPQUFPO0FBQUEsSUFDTCxRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsSUFDWCxRQUFRO0FBQUEsSUFDUixhQUFhO0FBQUEsSUFDYixLQUFLO0FBQUEsTUFDSCxPQUFPO0FBQUEsUUFDTCxLQUFLLFFBQVEsa0NBQVcsWUFBWTtBQUFBLE1BQ3RDO0FBQUEsTUFDQSxTQUFTLENBQUMsSUFBSTtBQUFBLE1BQ2QsVUFBVSxNQUFNO0FBQUEsSUFDbEI7QUFBQSxJQUNBLGVBQWU7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLE1BS2IsVUFBVSxDQUFDLFVBQVUsb0NBQW9DLGdCQUFnQix3QkFBd0I7QUFBQSxNQUNqRyxRQUFRO0FBQUE7QUFBQSxRQUVOLFFBQVE7QUFBQSxNQUNWO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFNBQVM7QUFBQSxJQUNQLElBQUk7QUFBQSxNQUNGLFdBQVc7QUFBQSxNQUNYLFFBQVE7QUFBQSxNQUNSLGNBQWM7QUFBQSxNQUNkLGFBQWE7QUFBQSxJQUNmLENBQUM7QUFBQSxFQUNIO0FBQUEsRUFDQSxRQUFRO0FBQUEsSUFDTixpQkFBaUIsS0FBSyxVQUFVLE9BQU87QUFBQSxFQUN6QztBQUFBLEVBQ0EsTUFBTTtBQUFBLElBQ0osYUFBYTtBQUFBLElBQ2IsU0FBUyxDQUFDLG1CQUFtQjtBQUFBLEVBQy9CO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
