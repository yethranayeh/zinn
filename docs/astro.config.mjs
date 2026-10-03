// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	site: "https://zinn.sh",
	output: "static",
	devToolbar: { enabled: false },
	integrations: [sitemap()],
	vite: { plugins: [tailwindcss()] }
});
