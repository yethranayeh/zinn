import type { APIRoute } from "astro";
import { isProductionSite } from "../config/site";

export const GET: APIRoute = ({ site }) => {
	const sitemap = isProductionSite ? `\nSitemap: ${new URL("/sitemap-index.xml", site).href}\n` : "";
	return new Response(`User-agent: *\nAllow: /\n${sitemap}`, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
