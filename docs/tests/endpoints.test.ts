import { opencodeInspector } from "../src/config/opencode-inspector";
import { opencodeScenes, opencodeTheme } from "../src/config/opencode-theme";
import { integrationLines, type IntegrationLine } from "../src/config/release-lines";
import { agentSetupPrompt, installCommand, minimumNodeVersion } from "../src/config/site";
import { splitShellCommands } from "../src/markdown/shell-commands";
import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const docsDirectory = resolve(import.meta.dir, "..");
const contentDirectory = join(docsDirectory, "src/content");
const markdownSources = (await readdir(contentDirectory, { recursive: true }))
  .filter((file) => file.endsWith(".mdx"))
  .sort();
// A page's route is its path under src/content without the .mdx extension and a trailing index, so docs/index.mdx serves /docs.
const routeOf = (source: string) => source.replace(/\.mdx$/, "").replace(/\/index$/, "");
const trustSources = markdownSources.filter((source) => !source.includes("/"));
// The changelog page is built from src/releases, so it has no file under src/content.
const trustPages = [...trustSources.map(routeOf), "changelog"];
const docsSources = markdownSources.filter((source) => source.startsWith("docs/"));
const docsPages = docsSources.map(routeOf);
const markdownPages = [...markdownSources.map(routeOf), "changelog"].sort();
const releasesDirectory = join(docsDirectory, "src/releases");
const baseUrl = process.env.SITE_TEST_URL;
if (!baseUrl) {
  throw new Error("Run bun run --cwd docs test to start the local Cloudflare server.");
}
const server = {
  fetch(path: string, init?: RequestInit) {
    return fetch(new URL(path, baseUrl), init);
  },
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
  const structuredData = [
    ...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/g),
  ].map((match) => JSON.parse(match[1]!));
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
  expect(html).toContain('href="/docs"');
});

test.each(trustSources)(
  "trust page %s has substantive HTML and an identical Markdown body",
  async (source) => {
    const page = routeOf(source);
    const response = await server.fetch(`/${page}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";
    expect(visibleText(main).length).toBeGreaterThanOrEqual(500);
    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    expect(html).toContain(`rel="alternate" type="text/markdown" href="/${page}.md"`);
    expect(html).toContain(`rel="canonical" href="https://zinn.sh/${page}/"`);
    const sourceText = await Bun.file(join(contentDirectory, source)).text();
    const lastUpdated = sourceText.match(/^lastUpdated: "([^"]+)"$/m)?.[1];
    const renderedDates = [...html.matchAll(/<time datetime="([^"]+)">([^<]+)<\/time>/g)].map(
      ([, datetime, text]) => ({ datetime, text }),
    );
    const isoDate = lastUpdated?.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, "$3-$2-$1");
    expect(renderedDates).toEqual(lastUpdated ? [{ datetime: isoDate, text: lastUpdated }] : []);
    await expectMarkdownTwin(page, source);
  },
);

async function expectMarkdownTwin(page: string, source: string) {
  const markdownResponse = await server.fetch(`/${page}.md`);
  expect(markdownResponse.status).toBe(200);
  expect(markdownResponse.headers.get("Content-Type")).toContain("text/markdown");
  const markdown = await markdownResponse.text();
  const sourceText = await Bun.file(join(contentDirectory, source)).text();
  const lastUpdated = sourceText.match(/^lastUpdated: "([^"]+)"$/m)?.[1];
  let expectedMarkdown = sourceText
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trimStart()
    .replace('import AgentSetup from "../../components/AgentSetup.astro";\n', "")
    .replace('import Aside from "../../components/ui/aside/Aside.astro";\n', "")
    .replace(/^\n/, "")
    .replace("<AgentSetup />\n\n", "")
    .replace(
      /<Aside label='([^']+)'>\n\n([\s\S]*?)\n\n<\/Aside>\n\n/g,
      (_match, label, content) => {
        const quoted = content
          .split("\n")
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n");
        return `> **${label}**\n>\n${quoted}\n\n`;
      },
    );
  if (lastUpdated) {
    expectedMarkdown = expectedMarkdown.replace(/^(# .+)$/m, `$1\n\nLast updated: ${lastUpdated}`);
  }
  expect(markdown).toBe(expectedMarkdown);
  expect(markdown).toStartWith("# ");
  expect(markdown).not.toContain("layout:");
  return markdown;
}

test("changelog and its Markdown twin list every release entry, newest first", async () => {
  const npmUrl = (name: string, version: string) =>
    `https://www.npmjs.com/package/@zinn-dev/${name}/v/${version}`;
  const readRelease = async (file: string) => {
    const source = await Bun.file(join(releasesDirectory, file)).text();
    const [, frontmatter = "", notes = ""] =
      source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/) ?? [];
    const field = (key: string) =>
      frontmatter.match(new RegExp(`^${key}: "?([^"\\r\\n]+)"?$`, "m"))?.[1];
    return { field, notes: notes.trim() };
  };
  const releaseFiles = (await readdir(releasesDirectory, { recursive: true })).filter((file) =>
    file.endsWith(".mdx"),
  );
  const zinnReleases = await Promise.all(
    releaseFiles
      .filter((file) => !file.includes("/"))
      .map(async (file) => {
        const { field, notes } = await readRelease(file);
        const version = field("version")!;
        const cli = field("cli")!;
        const core = field("core")!;
        return {
          zinnLine: true,
          version,
          date: field("date")!,
          notes,
          title: version,
          name: field("name"),
          // Published links point at these anchors.
          anchor: `release-${version.replaceAll(".", "")}`,
          packages: [
            { label: `CLI ${cli}`, url: npmUrl("cli", cli) },
            { label: `Core ${core}`, url: npmUrl("core", core) },
          ],
        };
      }),
  );
  const integrationReleases = await Promise.all(
    releaseFiles
      .filter((file) => file.includes("/"))
      .map(async (file) => {
        const line = file.split("/")[0] as IntegrationLine;
        expect(Object.keys(integrationLines)).toContain(line);
        const { label, packageName } = integrationLines[line];
        const { field, notes } = await readRelease(file);
        const version = field("version")!;
        return {
          zinnLine: false,
          version,
          date: field("date")!,
          notes,
          title: `${label} ${version}`,
          name: undefined,
          anchor: `release-${line}-${version.replaceAll(".", "")}`,
          packages: [
            { label: `@zinn-dev/${packageName} ${version}`, url: npmUrl(packageName, version) },
          ],
        };
      }),
  );
  // Zinn releases come before integration releases from the same day.
  const releases = [...zinnReleases, ...integrationReleases].sort(
    (a, b) => b.date.localeCompare(a.date) || Number(b.zinnLine) - Number(a.zinnLine),
  );
  expect(zinnReleases.length).toBeGreaterThan(0);
  expect(integrationReleases.length).toBeGreaterThan(0);

  const markdownResponse = await server.fetch("/changelog.md");
  expect(markdownResponse.status).toBe(200);
  expect(markdownResponse.headers.get("Content-Type")).toContain("text/markdown");
  const markdown = await markdownResponse.text();
  expect(markdown).toStartWith("# CHANGELOG\n");
  expect(markdown).toEndWith("\n");
  const html = await (await server.fetch("/changelog")).text();
  expect(html).toContain('rel="alternate" type="text/markdown" href="/changelog.md"');
  expect(html).toContain('rel="canonical" href="https://zinn.sh/changelog/"');
  expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);

  let markdownCursor = 0;
  let htmlCursor = 0;
  for (const release of releases) {
    const heading = [release.title, release.name].filter(Boolean).join(" ");
    const headingAt = markdown.indexOf(`\n## ${heading} - ${release.date}\n`, markdownCursor);
    expect(headingAt).toBeGreaterThanOrEqual(markdownCursor);
    const packageLine = release.packages.map(({ label, url }) => `[${label}](${url})`).join(" | ");
    const packagesAt = markdown.indexOf(`\n${packageLine}\n`, headingAt);
    expect(packagesAt).toBeGreaterThan(headingAt);
    const notesAt = markdown.indexOf(release.notes, packagesAt);
    expect(notesAt).toBeGreaterThan(packagesAt);
    markdownCursor = notesAt + release.notes.length;

    const anchorAt = html.indexOf(`id="${release.anchor}"`, htmlCursor);
    expect(anchorAt).toBeGreaterThanOrEqual(htmlCursor);
    expect(html.indexOf(`>${release.title}<`, anchorAt)).toBeGreaterThan(anchorAt);
    const timeAt = html.indexOf(`datetime="${release.date}"`, anchorAt);
    expect(timeAt).toBeGreaterThan(anchorAt);
    for (const { url } of release.packages) {
      expect(html.indexOf(`href="${url}"`, timeAt)).toBeGreaterThan(timeAt);
    }
    expect(html).toContain(`href="#${release.anchor}"`);
    htmlCursor = timeAt;
  }
});

test.each(docsSources)(
  "docs page %s has a Markdown twin and breadcrumbs matching its structured data",
  async (source) => {
    const page = routeOf(source);
    const response = await server.fetch(`/${page}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    expect(html).toContain(`rel="alternate" type="text/markdown" href="/${page}.md"`);
    expect(html).toContain(`rel="canonical" href="https://zinn.sh/${page}/"`);
    const markdown = await expectMarkdownTwin(page, source);
    // Shell blocks keep one prompt per command; other code blocks preserve their text without a prompt.
    const fences = [...markdown.matchAll(/^```([^\s`]+)(?: title="([^"]+)")?\n([\s\S]*?)^```$/gm)];
    const blocks = [
      ...html.matchAll(
        /<pre class="command-block[^"]*"[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/g,
      ),
    ];
    expect(markdown.match(/^```/gm)?.length ?? 0).toBe(fences.length * 2);
    expect(blocks).toHaveLength(fences.length);
    for (const [index, block] of blocks.entries()) {
      const [, language, sourceLabel, sourceCommands] = fences[index]!;
      const isShell = ["sh", "bash", "shell"].includes(language!);
      const commands = isShell
        ? splitShellCommands(sourceCommands!)
        : [sourceCommands!.replace(/^\n|\n$/g, "")];
      const expectedLabel =
        sourceLabel ??
        (language === "text" ? "Code" : language) + (isShell ? " commands" : " example");
      const promptCount = block[2]!.match(/aria-hidden="true">\$ <\/span>/g)?.length ?? 0;
      const blockTail = html.slice(block.index! + block[0].length);
      const copyButton = blockTail.match(
        /<button\b[^>]*data-copy-value="([\s\S]*?)"[^>]*>([\s\S]*?)<\/button>/,
      );
      expect(block[1]).toBe(expectedLabel);
      expect(promptCount).toBe(isShell ? commands.length : 0);
      expect(copyButton).toBeDefined();
      const copiedValue = copyButton?.[1]
        ?.replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      expect(copiedValue).toBe(commands.join("\n"));
    }

    const isDocsHome = page === "docs";
    const breadcrumbs = html.match(
      /<nav\b[^>]*aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/,
    )?.[1];
    expect(breadcrumbs === undefined).toBe(isDocsHome);
    if (isDocsHome) {
      return;
    }
    const visible = [
      ...breadcrumbs!.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>/g),
    ].map((match) => ({ name: match[2]!, item: new URL(match[1]!, "https://zinn.sh").href }));
    const structured = [
      ...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/g),
    ]
      .map((match) => JSON.parse(match[1]!))
      .find((data) => data["@type"] === "BreadcrumbList");
    expect(
      structured.itemListElement.map(({ name, item }: { name: string; item: string }) => ({
        name,
        item,
      })),
    ).toEqual(visible);
    expect(
      structured.itemListElement.map(({ position }: { position: number }) => position),
    ).toEqual(visible.map((_, index) => index + 1));
    expect(visible[0]!.item).toBe("https://zinn.sh/docs/");
    expect(visible.at(-1)!.item).toBe(`https://zinn.sh/${page}/`);
    expect(breadcrumbs).toMatch(new RegExp(`href="/${page}/"[^>]*aria-current="page"`));
  },
);

test("llms.txt follows the published structure and all local links work", async () => {
  const response = await server.fetch("/llms.txt");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/markdown");
  const markdown = await response.text();
  expect(markdown).toStartWith("# Zinn\n\n> ");
  expect(markdown).toContain("## When to use");
  const sections = markdown.split(/^## /m).slice(1);
  for (const section of sections) {
    const lines = section
      .split("\n")
      .slice(1)
      .filter((line) => line.trim());
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
  for (const fact of [
    "zinn --help",
    "projects",
    "tasks",
    "comments",
    "JSON",
    "Experimental",
    "/docs/cli.md",
    "/docs/quick-start.md",
  ]) {
    expect(markdown).toContain(fact);
  }
});

test("discovery uses existing documentation without a standalone agent guide", async () => {
  for (const path of [
    "/",
    "/index.md",
    "/llms.txt",
    ...markdownPages.flatMap((page) => [`/${page}`, `/${page}.md`]),
  ]) {
    expect(await (await server.fetch(path)).text()).not.toContain("/agents.md");
  }
  expect((await server.fetch("/agents.md")).status).toBe(404);
});

test.each(["text/markdown", "text/html"])(
  "missing paths preserve 404, security headers and HEAD for %s",
  async (accept) => {
    const path = "/__agent-readiness-does-not-exist/nested?probe=1";
    const response = await server.fetch(path, { headers: { accept } });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain(accept);
    expect(response.headers.get("Vary")).toContain("Accept");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    for (const header of [
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Strict-Transport-Security",
    ]) {
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
  },
);

test("every generated public endpoint is served with its expected type", async () => {
  for (const [path, mediaType] of [
    ["/index.md", "text/markdown"],
    ["/robots.txt", "text/plain"],
    ["/sitemap-index.xml", "application/xml"],
    ["/sitemap-0.xml", "application/xml"],
    ["/schemas/settings/v1.json", "application/json"],
    ["/social/zinn.png", "image/png"],
    ["/social/changelog.png", "image/png"],
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
  expect(robots.includes("Sitemap: https://zinn.sh/sitemap-index.xml")).toBe(
    process.env.SITE_TEST_ENV === "production",
  );
  const sitemap = await (await server.fetch("/sitemap-0.xml")).text();
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
  expect(locations).toEqual([
    "https://zinn.sh/",
    ...[
      ...markdownPages,
      "integrations",
      opencodeTheme.path.slice(1),
      opencodeInspector.path.slice(1),
    ]
      .sort()
      .map((page) => `https://zinn.sh/${page}/`),
  ]);
  for (const location of locations) {
    expect((await server.fetch(new URL(location).pathname)).status).toBe(200);
  }
  const schema = await (await server.fetch("/schemas/settings/v1.json")).json();
  expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  expect(schema.type).toBe("object");
});

// Sitemap pages that have no Markdown twin, each with the reason. Empty because every page has one.
const pagesWithoutMarkdownTwin: Record<string, string> = {};

test("every sitemap page has a Markdown twin", async () => {
  const sitemap = await (await server.fetch("/sitemap-0.xml")).text();
  const pathnames = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => new URL(match[1]!).pathname,
  );
  expect(pathnames.length).toBeGreaterThan(0);
  const missing: string[] = [];
  for (const pathname of pathnames) {
    if (pathname in pagesWithoutMarkdownTwin) {
      continue;
    }
    // Same rule as the rel="alternate" link in BaseLayout.
    const twinPath = pathname === "/" ? "/index.md" : `${pathname.replace(/\/$/, "")}.md`;
    const response = await server.fetch(twinPath);
    // A route without a GET handler is built as the HTML 404 page under the .md name, so the body must not be HTML.
    const body = await response.text();
    const isMarkdown =
      (response.headers.get("Content-Type") ?? "").includes("text/markdown") &&
      !body.trimStart().startsWith("<");
    if (response.status !== 200 || !isMarkdown) {
      missing.push(twinPath);
    }
  }
  expect(missing).toEqual([]);
});

async function expectSocialImage(path: string) {
  const response = await server.fetch(path);
  expect(response.status).toBe(200);
  const png = Buffer.from(await response.arrayBuffer());
  const signature = Buffer.from("\x89PNG\r\n\x1a\n", "binary");
  expect(png.subarray(0, signature.length)).toEqual(signature);
  // PNG's IHDR chunk starts with two four-byte dimensions after the chunk header.
  const chunkHeaderBytes = 8;
  const dimensionBytes = 4;
  const dimensionsOffset = signature.length + chunkHeaderBytes;
  expect(png.readUInt32BE(dimensionsOffset)).toBe(1200);
  expect(png.readUInt32BE(dimensionsOffset + dimensionBytes)).toBe(630);
}

test("social preview is a 1200 by 630 PNG linked by homepage metadata", async () => {
  const html = await (await server.fetch("/")).text();
  expect(html).toContain('content="https://zinn.sh/social/zinn.png"');
  await expectSocialImage("/social/zinn.png");
});

test("changelog preview is a 1200 by 630 PNG linked by changelog metadata", async () => {
  const html = await (await server.fetch("/changelog")).text();
  const image = html.match(/property="og:image" content="([^"]+)"/)?.[1];
  const twitterImage = html.match(/name="twitter:image" content="([^"]+)"/)?.[1];
  expect(image).toBe("https://zinn.sh/social/changelog.png");
  expect(twitterImage).toBe(image);
  const alt = html.match(/property="og:image:alt" content="([^"]+)"/)?.[1];
  const twitterAlt = html.match(/name="twitter:image:alt" content="([^"]+)"/)?.[1];
  expect(alt?.length).toBeGreaterThan(0);
  expect(twitterAlt).toBe(alt);
  const homepageHtml = await (await server.fetch("/")).text();
  const homepageAlt = homepageHtml.match(/property="og:image:alt" content="([^"]+)"/)?.[1];
  expect(alt).not.toBe(homepageAlt);
  await expectSocialImage("/social/changelog.png");
});

test("agent setup prompt uses the installation command and supported runtime", async () => {
  for (const command of [
    installCommand,
    "node --version",
    "zinn --version",
    "npx skills add yethranayeh/zinn --skill zinn -g -y",
    "zinn --help",
    minimumNodeVersion,
  ]) {
    expect(agentSetupPrompt).toContain(command);
  }
  const installation = await Bun.file(join(contentDirectory, "docs/installation.mdx")).text();
  expect(installation).toContain(minimumNodeVersion);
  for (const path of ["/", "/docs/installation"]) {
    const html = await (await server.fetch(path)).text();
    expect(html).toContain('data-copy-event="prompt-copy"');
    expect(visibleText(html)).not.toContain(agentSetupPrompt);
  }
});

test.each([
  ...docsPages,
  "changelog",
  "integrations",
  opencodeTheme.path.slice(1),
  opencodeInspector.path.slice(1),
])("%s offers its Markdown actions directly after the heading", async (page) => {
  const html = await (await server.fetch(`/${page}`)).text();
  expect(html).toMatch(new RegExp(`</h1>\\s*<div[^>]*>[\\s\\S]*?data-copy-url="/${page}\\.md"`));
  expect(html).toContain(`href="/${page}.md"`);
  expect(html).toContain('data-copy-event="markdown-copy"');
  expect(html.match(/aria-label="Markdown actions"/g)).toHaveLength(1);
  const markdown = await server.fetch(`/${page}.md`);
  expect(markdown.status).toBe(200);
  expect(markdown.headers.get("Content-Type")).toContain("text/markdown");
});

test("integration routes expose the gallery, Markdown and canonical theme download", async () => {
  const index = await server.fetch("/integrations");
  expect(index.status).toBe(200);
  expect(await index.text()).toContain(`href="${opencodeTheme.path}"`);
  const response = await server.fetch(opencodeTheme.path);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain(`rel="canonical" href="https://zinn.sh${opencodeTheme.path}/"`);
  expect(html).toContain(`href="${opencodeTheme.download}"`);
  expect(html).toContain("data-screenshot-gallery");
  expect(html).toContain("<dialog");
  expect(html).toContain("<noscript>");
  expect(html).toContain("/icons.svg#download");
  for (const scene of opencodeScenes) {
    expect(html).toContain(`data-gallery-scene="${scene.id}"`);
    for (const url of Object.values(scene.images)) {
      expect(html).toContain(url!);
    }
  }
  const isProductionBuild = process.env.SITE_TEST_ENV === "production";
  expect(html.includes('name="robots" content="noindex"')).toBe(!isProductionBuild);
  expect(html.includes("https://cloud.umami.is/script.js")).toBe(isProductionBuild);
  for (const path of ["/integrations", opencodeTheme.path]) {
    const markdown = await server.fetch(`${path}.md`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("Content-Type")).toContain("text/markdown");
    expect(await markdown.text()).toContain(opencodeTheme.download);
  }
  const markdown = await (await server.fetch(`${opencodeTheme.path}.md`)).text();
  for (const scene of opencodeScenes) {
    for (const url of Object.values(scene.images)) {
      expect(markdown).toContain(url!);
    }
  }
  const download = await server.fetch(opencodeTheme.download);
  expect(download.status).toBe(200);
  expect(download.headers.get("Content-Type")).toContain("application/json");
  expect(download.headers.get("Content-Disposition")).toContain('filename="zinn.json"');
  expect(await download.text()).toBe(
    await Bun.file(join(docsDirectory, "../integrations/opencode/theme/zinn.json")).text(),
  );
});

test("inspector integration page carries the setup guide and its Markdown twin", async () => {
  const index = await server.fetch("/integrations");
  expect(await index.text()).toContain(`href="${opencodeInspector.path}"`);
  const response = await server.fetch(opencodeInspector.path);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain(`rel="canonical" href="https://zinn.sh${opencodeInspector.path}/"`);
  expect(html).toContain('rel="alternate" type="text/markdown"');
  expect(html).toContain(opencodeInspector.package);
  expect(html).toContain("cli.json");
  expect(html).toContain("ZINN_THREAD_ID");
  const markdown = await server.fetch(`${opencodeInspector.path}.md`);
  expect(markdown.status).toBe(200);
  expect(markdown.headers.get("Content-Type")).toContain("text/markdown");
  const text = await markdown.text();
  expect(text).toContain(opencodeInspector.package);
  expect(text).toContain(opencodeInspector.verifiedVersion);
  expect(text).toContain(opencodeInspector.minimumCliVersion);
  expect(text).toContain("cli.json");
  expect(text).toContain("ZINN_THREAD_ID");
});
