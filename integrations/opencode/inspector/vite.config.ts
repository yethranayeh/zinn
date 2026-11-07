import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

export default defineConfig({
  plugins: [gui({ entry: "pkg/gui/index.tsx", outFile: "dist/gui-experimental.cjs" })],
  build: { emptyOutDir: false },
});
