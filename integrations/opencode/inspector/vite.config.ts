import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

/**
 * The GUI files carry a `@jsxImportSource solid-js` pragma for the repo typecheck.
 * esbuild rejects that pragma under `jsx: preserve`, so the GUI tsconfig uses react-jsx
 * The Solid Vite plugin has already transformed the JSX
 */
export default defineConfig({
  plugins: [gui({ entry: "pkg/gui/index.tsx", outFile: "dist/gui-experimental.cjs" })],
  build: { emptyOutDir: false },
});
