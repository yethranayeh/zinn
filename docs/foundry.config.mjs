// @ts-check
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Astro resolves these from the working directory, so they are made absolute from this file
const fromDocs = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));
const publicDir = fromDocs("./public");

// The files from public/ that Foundry ships: what its pages and styles load, and their licenses
export const shippedPublicFiles = [
	"art/halftone-ramp.svg",
	"favicon.svg",
	"fonts/AlanSans-OFL.txt",
	"fonts/AlanSans.ttf",
	"fonts/monoMMM-NOTICE.txt",
	"fonts/monoMMM_5.ttf",
	"icons.svg",
	"pixelarticons-LICENSE.txt"
];

// Astro copies all of public/ into the build, so this removes what Foundry does not ship
/** @type {import("astro").AstroIntegration} */
const shipListedPublicFiles = {
	name: "foundry-public-files",
	hooks: {
		"astro:build:done": async ({ dir }) => {
			const removeUnlisted = async (/** @type {string} */ folder) => {
				for (const entry of await readdir(join(publicDir, folder), { withFileTypes: true })) {
					const path = folder + entry.name;
					const holdsShippedFiles = shippedPublicFiles.some((file) => file.startsWith(`${path}/`));
					if (entry.isDirectory() && holdsShippedFiles) {
						await removeUnlisted(`${path}/`);
					} else if (!shippedPublicFiles.includes(path)) {
						await rm(join(fileURLToPath(dir), path), { recursive: true, force: true });
					}
				}
			};
			await removeUnlisted("");
		}
	}
};

// Its root is foundry/, so its generated .astro/ folder stays apart from the actual site's one
export default defineConfig({
	root: fromDocs("./foundry"),
	srcDir: fromDocs("./foundry"),
	publicDir,
	outDir: fromDocs("./dist-foundry"),
	cacheDir: fromDocs("./node_modules/.astro-foundry"),
	output: "static",
	devToolbar: { enabled: false },
	integrations: [shipListedPublicFiles],
	vite: {
		cacheDir: fromDocs("./node_modules/.vite-foundry"),
		plugins: [tailwindcss()]
	}
});
