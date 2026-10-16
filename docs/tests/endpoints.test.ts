import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const docsDirectory = resolve(import.meta.dir, "..");
const contentDirectory = join(docsDirectory, "src/content");
const markdownSources = (await readdir(contentDirectory, { recursive: true }))
	.filter((file) => file.endsWith(".mdx")).sort();
// A page's route drops the pages/ folder, the .mdx extension and a trailing index, so docs/index.mdx serves /docs.
const routeOf = (source: string) => source.replace(/^pages\//, "").replace(/\.mdx$/, "").replace(/\/index$/, "");
const trustSources = markdownSources.filter((source) => source.startsWith("pages/"));
const trustPages = trustSources.map(routeOf);
const docsSources = markdownSources.filter((source) => source.startsWith("docs/"));
const docsPages = docsSources.map(routeOf);
const markdownPages = markdownSources.map(routeOf).sort();
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
	expect(html).toContain('href="/docs/installation"');
});

test.each(trustSources)("trust page %s has substantive HTML and an identical Markdown body", async (source) => {
	const page = routeOf(source);
	const response = await server.fetch(`/${page}`);
	expect(response.status).toBe(200);
	const html = await response.text();
	const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";
	expect(visibleText(main).length).toBeGreaterThanOrEqual(500);
	expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
	expect(html).toContain(`rel="alternate" type="text/markdown" href="/${page}.md"`);
	expect(html).toContain(`rel="canonical" href="https://zinn.sh/${page}/"`);
	await expectMarkdownTwin(page, source);
});

async function expectMarkdownTwin(page: string, source: string) {
	const markdownResponse = await server.fetch(`/${page}.md`);
	expect(markdownResponse.status).toBe(200);
	expect(markdownResponse.headers.get("Content-Type")).toContain("text/markdown");
	const markdown = await markdownResponse.text();
	const sourceText = await Bun.file(join(contentDirectory, source)).text();
	expect(markdown).toBe(sourceText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart());
	expect(markdown).toStartWith("# ");
	expect(markdown).not.toContain("layout:");
	return markdown;
}

test.each(docsSources)("docs page %s has a Markdown twin and breadcrumbs matching its structured data", async (source) => {
	const page = routeOf(source);
	const response = await server.fetch(`/${page}`);
	expect(response.status).toBe(200);
	const html = await response.text();
	expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
	expect(html).toContain(`rel="alternate" type="text/markdown" href="/${page}.md"`);
	expect(html).toContain(`rel="canonical" href="https://zinn.sh/${page}/"`);
	const markdown = await expectMarkdownTwin(page, source);
	// Every fenced block renders as a labelled terminal block with a prompt per command.
	const fences = [...markdown.matchAll(/^```sh title="([^"]+)"\n([\s\S]*?)^```$/gm)];
	const blocks = [...html.matchAll(/<pre class="command-block[^"]*"[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/g)];
	expect(markdown.match(/^```/gm)?.length ?? 0).toBe(fences.length * 2);
	expect(blocks.map((block) => block[1])).toEqual(fences.map((fence) => fence[1]!));
	for (const [index, block] of blocks.entries()) {
		const commands = fences[index]![2]!.trim().split(/\n\s*\n/);
		expect(block[2]!.match(/aria-hidden="true">\$ <\/span>/g)?.length).toBe(commands.length);
	}

	const isDocsHome = page === "docs";
	const breadcrumbs = html.match(/<nav\b[^>]*aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
	expect(breadcrumbs === undefined).toBe(isDocsHome);
	if (isDocsHome) {
		return;
	}
	const visible = [...breadcrumbs!.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>/g)]
		.map((match) => ({ name: match[2]!, item: new URL(match[1]!, "https://zinn.sh").href }));
	const structured = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/g)]
		.map((match) => JSON.parse(match[1]!)).find((data) => data["@type"] === "BreadcrumbList");
	expect(structured.itemListElement.map(({ name, item }: { name: string; item: string }) => ({ name, item }))).toEqual(visible);
	expect(structured.itemListElement.map(({ position }: { position: number }) => position)).toEqual(visible.map((_, index) => index + 1));
	expect(visible[0]!.item).toBe("https://zinn.sh/docs/");
	expect(visible.at(-1)!.item).toBe(`https://zinn.sh/${page}/`);
	expect(breadcrumbs).toMatch(new RegExp(`href="/${page}/"[^>]*aria-current="page"`));
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
	for (const path of ["/", "/index.md", "/llms.txt", ...markdownPages.flatMap((page) => [`/${page}`, `/${page}.md`])]) {
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
		["/schemas/settings/v1.json", "application/json"], ["/social/zinn.png", "image/png"]
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
	expect(locations).toEqual(["https://zinn.sh/", ...markdownPages.map((page) => `https://zinn.sh/${page}/`)]);
	for (const location of locations) {
		expect((await server.fetch(new URL(location).pathname)).status).toBe(200);
	}
	const schema = await (await server.fetch("/schemas/settings/v1.json")).json();
	expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
	expect(schema.type).toBe("object");
});

test("social preview is a 1200 by 630 PNG linked by homepage metadata", async () => {
	const html = await (await server.fetch("/")).text();
	expect(html).toContain('content="https://zinn.sh/social/zinn.png"');
	const response = await server.fetch("/social/zinn.png");
	const png = Buffer.from(await response.arrayBuffer());
	const signature = Buffer.from("\x89PNG\r\n\x1a\n", "binary");
	expect(png.subarray(0, signature.length)).toEqual(signature);
	// PNG's IHDR chunk starts with two four-byte dimensions after the chunk header.
	const chunkHeaderBytes = 8;
	const dimensionBytes = 4;
	const dimensionsOffset = signature.length + chunkHeaderBytes;
	expect(png.readUInt32BE(dimensionsOffset)).toBe(1200);
	expect(png.readUInt32BE(dimensionsOffset + dimensionBytes)).toBe(630);
});
