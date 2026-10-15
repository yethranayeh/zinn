// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import mdx from "@astrojs/mdx";
import { satteri } from "@astrojs/markdown-satteri";
import { commandBlocks } from "./src/markdown/command-blocks.mjs";

export default defineConfig({
	site: "https://zinn.sh",
	output: "static",
	devToolbar: { enabled: false },
	integrations: [
		sitemap({ filter: (page) => !page.endsWith(".md") }),
		mdx({ processor: satteri({ hastPlugins: [commandBlocks] }) })
	],
	markdown: { syntaxHighlight: false },
	vite: { plugins: [tailwindcss()] }
});
