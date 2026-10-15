import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const docsDirectory = resolve(import.meta.dir, "..");
const trustPages = (await readdir(join(docsDirectory, "src/pages")))
	.filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)).sort();
const baseUrl = process.env.SITE_TEST_URL;
if (!baseUrl) {
	throw new Error("Run bun run --cwd docs test to start the local Cloudflare server.");
}
const server = {
	fetch(path: string, init?: RequestInit) {
		return fetch(new URL(path, baseUrl), init);
	}
};

function visibleText(html: string): string {
	return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
}

test("homepage preserves product metadata, structured data and install commands", async () => {
	const response = await server.fetch("/");
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toContain("text/html");
	const html = await response.text();
	expect(html).toMatch(/<title>[^<]*Zinn[^<]*Kanban CLI/);
	expect(visibleText(html)).toContain("Zinn: a kanban CLI");
	expect(html).toContain("npm i -g @zinn-dev/cli");
	expect(html).toContain("zinn --help");
	expect(html).toMatch(/rel="canonical" href="https:\/\/zinn.sh\/"/);
	const structuredData = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/g)]
		.map((match) => JSON.parse(match[1]!));
	expect(structuredData.map((data) => data["@type"])).toEqual(["WebSite", "SoftwareApplication"]);
	for (const data of structuredData) {
		expect(data.name).toBe("Zinn");
		expect(data.url).toBe("https://zinn.sh/");
	}
	const isProductionBuild = process.env.SITE_TEST_ENV === "production";
	expect(html.includes('name="robots" content="noindex"')).toBe(!isProductionBuild);
	expect(html.includes("https://cloud.umami.is/script.js")).toBe(isProductionBuild);
	expect(html).toContain('rel="describedby" href="/llms.txt"');
	expect(html).toContain('rel="alternate" type="text/markdown" href="/index.md"');
	for (const page of trustPages) {
		expect(html).toContain(`href="/${page}"`);
	}
});

test.each(trustPages)("/%s has substantive HTML and an identical Markdown body", async (page) => {
	const response = await server.fetch(`/${page}`);
	expect(response.status).toBe(200);
	const html = await response.text();
	const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";
	expect(visibleText(main).length).toBeGreaterThanOrEqual(500);
	expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
	expect(html).toContain(`rel="alternate" type="text/markdown" href="/${page}.md"`);
	expect(html).toContain(`rel="canonical" href="https://zinn.sh/${page}/"`);
	const markdownResponse = await server.fetch(`/${page}.md`);
	expect(markdownResponse.status).toBe(200);
	expect(markdownResponse.headers.get("Content-Type")).toContain("text/markdown");
	const markdown = await markdownResponse.text();
	const source = await Bun.file(join(docsDirectory, `src/pages/${page}.md`)).text();
	expect(markdown).toBe(source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart());
	expect(markdown).toStartWith("# ");
	expect(markdown).not.toContain("layout:");
});

test("llms.txt follows the published structure and all local links work", async () => {
	const response = await server.fetch("/llms.txt");
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toContain("text/markdown");
	const markdown = await response.text();
	expect(markdown).toStartWith("# Zinn\n\n> ");
	expect(markdown).toContain("## When to use");
	const sections = markdown.split(/^## /m).slice(1);
	for (const section of sections) {
		const lines = section.split("\n").slice(1).filter((line) => line.trim());
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\)(: .+)?$/);
		}
	}
	for (const match of markdown.matchAll(/\]\((https:\/\/zinn.sh\/[^)]+)\)/g)) {
		const target = await server.fetch(new URL(match[1]!).pathname);
		expect(target.status).toBe(200);
		expect(target.headers.get("Content-Type")).toContain("text/markdown");
	}
	for (const fact of ["zinn --help", "projects", "tasks", "comments", "JSON", "Experimental", "packages/cli/README.md"]) {
		expect(markdown).toContain(fact);
	}
});

test("discovery uses existing documentation without a standalone agent guide", async () => {
	for (const path of ["/", "/index.md", "/llms.txt", ...trustPages.flatMap((page) => [`/${page}`, `/${page}.md`])]) {
		expect(await (await server.fetch(path)).text()).not.toContain("/agents.md");
	}
	expect((await server.fetch("/agents.md")).status).toBe(404);
});

test.each(["text/markdown", "text/html"])("missing paths preserve 404, security headers and HEAD for %s", async (accept) => {
	const path = "/__agent-readiness-does-not-exist/nested?probe=1";
	const response = await server.fetch(path, { headers: { accept } });
	expect(response.status).toBe(404);
	expect(response.headers.get("Content-Type")).toContain(accept);
	expect(response.headers.get("Vary")).toContain("Accept");
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	for (const header of ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Strict-Transport-Security"]) {
		expect(response.headers.get(header)).not.toBeNull();
	}
	const body = await response.text();
	if (accept === "text/markdown") {
		expect(body.length).toBeGreaterThanOrEqual(20);
		expect(body).toContain("[llms.txt](https://zinn.sh/llms.txt)");
	} else {
		expect(body).toContain('<meta name="robots" content="noindex">');
		expect(body).not.toContain('rel="canonical"');
		expect(body).toBe(await Bun.file(join(docsDirectory, "dist/404.html")).text());
		expect(body).not.toContain('aria-label="Zinn project information"');
		expect(body).toMatch(/<a\b[^>]*href="\/"[^>]*>/);
	}
	const head = await server.fetch(path, { method: "HEAD", headers: { accept } });
	expect(head.status).toBe(404);
	expect(head.headers.get("Content-Type")).toBe(response.headers.get("Content-Type"));
	expect(await head.text()).toBe("");
});

test("every generated public endpoint is served with its expected type", async () => {
	for (const [path, mediaType] of [
		["/index.md", "text/markdown"], ["/robots.txt", "text/plain"],
		["/sitemap-index.xml", "application/xml"], ["/sitemap-0.xml", "application/xml"],
		["/schemas/settings/v1.json", "application/json"]
	]) {
		const response = await server.fetch(path!);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain(mediaType!);
		const head = await server.fetch(path!, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("Content-Type")).toBe(response.headers.get("Content-Type"));
		expect(await head.text()).toBe("");
	}
	const robots = await (await server.fetch("/robots.txt")).text();
	expect(robots).toContain("User-agent: *");
	expect(robots.includes("Sitemap: https://zinn.sh/sitemap-index.xml")).toBe(process.env.SITE_TEST_ENV === "production");
	const sitemap = await (await server.fetch("/sitemap-0.xml")).text();
	const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
	expect(locations).toEqual(["https://zinn.sh/", ...trustPages.map((page) => `https://zinn.sh/${page}/`)]);
	for (const location of locations) {
		expect((await server.fetch(new URL(location).pathname)).status).toBe(200);
	}
	const schema = await (await server.fetch("/schemas/settings/v1.json")).json();
	expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
	expect(schema.type).toBe("object");
});
