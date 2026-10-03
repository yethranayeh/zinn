// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	site: "https://zinn.sh",
	output: "static",
	devToolbar: { enabled: false },
	vite: { plugins: [tailwindcss()] },
});
