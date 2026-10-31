// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Astro resolves these from the working directory, so they are made absolute from this file
const fromDocs = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));

// Its root is foundry/, so its generated .astro/ folder stays apart from the actual site's one
export default defineConfig({
	root: fromDocs("./foundry"),
	srcDir: fromDocs("./foundry"),
	publicDir: fromDocs("./public"),
	outDir: fromDocs("./dist-foundry"),
	cacheDir: fromDocs("./node_modules/.astro-foundry"),
	output: "static",
	devToolbar: { enabled: false },
	vite: {
		cacheDir: fromDocs("./node_modules/.vite-foundry"),
		plugins: [tailwindcss()]
	}
});
