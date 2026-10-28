// @ts-check
import { existsSync, readdirSync } from "node:fs";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import mdx from "@astrojs/mdx";
import { satteri } from "@astrojs/markdown-satteri";
import { commandBlocks } from "./src/markdown/command-blocks.mjs";

const prototypesDir = new URL("./src/prototypes/", import.meta.url);

// Serves pages in src/prototypes/ at /prototypes/<name>/ in dev only. They live outside src/pages/, so builds never include them.
const devPrototypes = {
	name: "dev-prototypes",
	hooks: {
		/** @param {import("astro").HookParameters<"astro:config:setup">} options */
		"astro:config:setup": ({ command, injectRoute }) => {
			if (command !== "dev" || !existsSync(prototypesDir)) {
				return;
			}
			for (const file of readdirSync(prototypesDir).filter((name) => name.endsWith(".astro"))) {
				injectRoute({
					pattern: `/prototypes/${file.slice(0, -".astro".length)}`,
					entrypoint: new URL(file, prototypesDir)
				});
			}
		}
	}
};

export default defineConfig({
	site: "https://zinn.sh",
	output: "static",
	devToolbar: { enabled: false },
	integrations: [
		sitemap({ filter: (page) => !page.endsWith(".md") }),
		mdx({ processor: satteri({ hastPlugins: [commandBlocks] }) }),
		devPrototypes
	],
	markdown: { syntaxHighlight: false },
	vite: { plugins: [tailwindcss()] }
});
