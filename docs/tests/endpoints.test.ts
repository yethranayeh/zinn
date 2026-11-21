import {
  cliIntegrity,
  comparison,
  energyLabel,
  energyMethodNote,
  measurementNote,
  nodeEnergyLabel,
  questions,
  storageNote,
} from "../src/components/pricing/figures";
import { inspectorSections } from "../src/components/inspector/content";
import { firefoxTheme } from "../src/config/firefox-theme";
import { integrationsHub } from "../src/config/integrations-hub";
import { integrations } from "../src/config/integrations";
import {
  desktopBottomSlot,
  inspectorPluginConfig,
  opencodeInspector,
} from "../src/config/opencode-inspector";
import { opencodeScenes, opencodeTheme } from "../src/config/opencode-theme";
import { rexScenes, rexTheme } from "../src/config/rex-theme";
import {
  exactBytes,
  largeListCost,
  memoryLabel,
  outputLabel,
  pricingCommands,
  pricingPackages,
  pricingTotals,
  sizeLabel,
} from "../src/config/pricing";
import { integrationLines, type IntegrationLine } from "../src/config/release-lines";
import { agentSetupPrompt, installCommand, minimumNodeVersion } from "../src/config/site";
import { splitShellCommands, startsWithShebang } from "../src/markdown/shell-commands";
import { markdownTwinPath } from "../src/markdown/twin-path";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
  expect(structuredData[1].softwareRequirements).toBe(`Node.js >=${minimumNodeVersion}`);
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
    .replace(/^import Kbd from "[^"]+";\n/m, "")
    .replace(/^import TopicIndex from "[^"]+";\n/m, "")
    .replace(/^\n/, "")
    .replace(/<Kbd\b[^>]*>([\s\S]*?)<\/Kbd>/g, (_match, label) => `\`${label.trim()}\``)
    .replace("<AgentSetup />\n\n", "")
    .replace(
      /<Aside\b[^>]*label='([^']+)'[^>]*>\n\n([\s\S]*?)\n\n<\/Aside>\n\n/g,
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
  expectedMarkdown = expectedMarkdown.replace(
    /\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g,
    (match, path, fragment = "") => {
      if (path.split("/").at(-1)!.includes(".")) {
        return match;
      }
      const target = path.replace(/\/$/, "");
      const anchor = fragment.split(":~:")[0].replace(/^#$/, "");
      return `](${target === "" ? "/index.md" : `${target}.md`}${anchor})`;
    },
  );
  const topicIndex = expectedMarkdown.match(/<TopicIndex(?:\s+label=(["'])(.*?)\1)?\s*\/>/);
  if (topicIndex) {
    const [before, after] = expectedMarkdown.split(topicIndex[0]);
    expect(markdown).toStartWith(before!);
    expect(markdown).toEndWith(after!);
    expect(markdown).not.toContain("<TopicIndex");
  } else {
    expect(markdown).toBe(expectedMarkdown);
  }
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
    return { field, frontmatter, notes: notes.trim() };
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
          lineLabel: "Zinn",
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
        const lineInfo = integrationLines[line];
        const { field, frontmatter, notes } = await readRelease(file);
        const version = field("version")!;
        // A GitHub line lists each plugin at the release commit, one indented `name: version` line each.
        const githubPackages = (folder: string) => {
          const commit = field("commit")!;
          const pluginBlock = frontmatter.match(/^plugins:\r?\n((?:[ \t]+\S.*\r?\n?)+)/m)?.[1] ?? "";
          const plugins = [...pluginBlock.matchAll(/^[ \t]+([\w-]+): "?([\d.]+)"?/gm)];
          expect(commit).toMatch(/^[0-9a-f]{40}$/);
          expect(plugins.length).toBeGreaterThan(0);
          return plugins.map(([, name, pluginVersion]) => ({
            label: `${name} ${pluginVersion}`,
            url: `https://github.com/yethranayeh/zinn/tree/${commit}/${folder}/${name}`,
          }));
        };
        return {
          zinnLine: false,
          version,
          date: field("date")!,
          notes,
          title: `${lineInfo.label} ${version}`,
          name: undefined,
          anchor: `release-${line}-${version.replaceAll(".", "")}`,
          lineLabel: lineInfo.label,
          packages:
            "npm" in lineInfo
              ? [{ label: `@zinn-dev/${lineInfo.npm} ${version}`, url: npmUrl(lineInfo.npm, version) }]
              : githubPackages(lineInfo.github),
        };
      }),
  );
  // Zinn releases come before integration releases from the same day, and releases that tie on
  // date and version fall back to the order of their line labels.
  const releases = [...zinnReleases, ...integrationReleases].sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      Number(b.zinnLine) - Number(a.zinnLine) ||
      b.version.localeCompare(a.version, undefined, { numeric: true }) ||
      a.lineLabel.localeCompare(b.lineLabel),
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

test("pricing page and its Markdown twin carry the same measured figures", async () => {
  const response = await server.fetch("/pricing");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  const html = await response.text();
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  const markdownResponse = await server.fetch("/pricing.md");
  expect(markdownResponse.status).toBe(200);
  expect(markdownResponse.headers.get("Content-Type")).toContain("text/markdown");
  const markdown = await markdownResponse.text();
  const firstCommand = pricingCommands[0]!;
  const facts = [
    sizeLabel(pricingTotals.softwareDownload),
    exactBytes(pricingTotals.softwareDownload),
    sizeLabel(pricingTotals.download),
    exactBytes(pricingTotals.download),
    memoryLabel(firstCommand.memoryBytes),
    memoryLabel(largeListCost.memoryBytes),
    `${firstCommand.seconds.toFixed(2)} s`,
    outputLabel(firstCommand.output),
    installCommand,
    ...pricingCommands.map((command) => command.command),
    storageNote,
    energyLabel(firstCommand.command),
    energyMethodNote,
    nodeEnergyLabel,
    cliIntegrity,
    measurementNote,
    ...comparison.flat(),
    ...questions.flatMap(({ q, a, code, after }) =>
      [q, a, code, after].filter((text) => text !== undefined),
    ),
  ];
  const pageText = visibleText(html);
  for (const fact of facts) {
    expect(pageText).toContain(fact);
    expect(markdown).toContain(fact);
  }
  // The package is presented as a whole, so no dependency is named.
  for (const dependency of pricingPackages.filter((entry) => !entry.zinn)) {
    expect(pageText).not.toContain(dependency.name);
    expect(markdown).not.toContain(dependency.name);
  }
  const grossButton = html.match(/<button\b[^>]*data-weight="gross"[^>]*>/)?.[0];
  const netButton = html.match(/<button\b[^>]*data-weight="net"[^>]*>/)?.[0];
  expect(grossButton).toContain('aria-pressed="true"');
  expect(netButton).toContain('aria-pressed="false"');
  const grossState = html.match(/<div\b[^>]*data-weight-state="gross"[^>]*>/)?.[0];
  const netState = html.match(/<div\b[^>]*data-weight-state="net"[^>]*>/)?.[0];
  expect(grossState).toBeDefined();
  expect(grossState).not.toMatch(/\bhidden(?:\s|=|>)/);
  expect(netState).toMatch(/\bhidden(?:\s|=|>)/);
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
    const sourceText = await Bun.file(join(contentDirectory, source)).text();
    const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)![1]!;
    const hasContents = /^toc: true$/m.test(sourceText) && /<h[23]\b/.test(article);
    expect(html.includes("data-section-link")).toBe(hasContents);
    expect(html).toContain("data-reading-page");
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
      const isScript = isShell && startsWithShebang(sourceCommands!);
      const isCommandList = isShell && !isScript;
      const commands = isCommandList
        ? splitShellCommands(sourceCommands!)
        : [sourceCommands!.replace(/^\n|\n$/g, "")];
      const blockKind = isCommandList ? "commands" : isScript ? "script" : "example";
      const expectedLabel =
        sourceLabel ?? `${language === "text" ? "Code" : language} ${blockKind}`;
      const promptCount = block[2]!.match(/aria-hidden="true">\$ <\/span>/g)?.length ?? 0;
      const blockTail = html.slice(block.index! + block[0].length);
      const copyButton = blockTail.match(
        /<button\b[^>]*data-copy-value="([\s\S]*?)"[^>]*>([\s\S]*?)<\/button>/,
      );
      expect(block[1]).toBe(expectedLabel);
      expect(promptCount).toBe(isCommandList ? commands.length : 0);
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
    `Node.js ${minimumNodeVersion}`,
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
    ["/social/pricing.png", "image/png"],
    ["/social/blame.png", "image/png"],
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
      "docs/blame",
      "performance",
      "pricing",
      "integrations",
      opencodeTheme.path.slice(1),
      opencodeInspector.path.slice(1),
      rexTheme.path.slice(1),
      firefoxTheme.path.slice(1),
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

/** Page text as a browser matches a text directive against it, without tags and with whitespace collapsed */
function pageText(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");
}

test("every same-site section link on a sitemap page reaches its heading", async () => {
  const sitemap = await (await server.fetch("/sitemap-0.xml")).text();
  const pathnames = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => new URL(match[1]!).pathname,
  );
  const pages = new Map<string, Promise<string>>();
  const pageAt = (pathname: string) => {
    let page = pages.get(pathname);
    if (!page) {
      page = server.fetch(pathname).then((response) => response.text());
      pages.set(pathname, page);
    }
    return page;
  };
  const broken: string[] = [];
  for (const pathname of pathnames) {
    const html = await pageAt(pathname);
    const hrefs = [...html.matchAll(/href="((?:https:\/\/zinn\.sh)?\/[^"#]*)#([^"]+)"/g)];
    for (const [, target, rawFragment] of hrefs) {
      const targetPath = target!.replace("https://zinn.sh", "");
      // A text directive follows the element anchor and is not part of the id
      const [fragment, directive] = rawFragment!.split(":~:");
      if (!fragment) {
        continue;
      }
      const targetHtml = await pageAt(targetPath);
      const anchorAt = targetHtml.indexOf(`id="${fragment}"`);
      if (anchorAt < 0) {
        broken.push(`${pathname} -> ${targetPath}#${fragment}`);
        continue;
      }
      if (!directive) {
        continue;
      }
      // The browser marks the first match on the page, so the phrase must occur once, inside the section
      const phrase = decodeURIComponent(directive.replace(/^text=/, ""));
      const nextHeading = targetHtml.slice(anchorAt).search(/<h[1-6][^>]*\sid="/);
      const sectionHtml = targetHtml.slice(anchorAt, nextHeading < 0 ? undefined : anchorAt + nextHeading);
      const occurrences = (text: string) => text.split(phrase).length - 1;
      if (occurrences(pageText(targetHtml)) !== 1 || occurrences(pageText(sectionHtml)) !== 1) {
        broken.push(`${pathname} -> ${targetPath}#${fragment}:~:${directive}`);
      }
    }
  }
  expect(broken).toEqual([]);
});

// The graph of steerdown's judgments is kept out of the repository. Builds without it emit no further reading data.
const hasSteerdownGraph = existsSync(join(docsDirectory, "steerdown.graph.json"));

test.skipIf(!hasSteerdownGraph)("every page with a table of contents has further reading data whose links reach their headings", async () => {
  const sitemap = await (await server.fetch("/sitemap-0.xml")).text();
  const pathnames = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => new URL(match[1]!).pathname,
  );
  const missing: string[] = [];
  const broken: string[] = [];
  let pagesWithContents = 0;
  for (const pathname of pathnames) {
    const html = await (await server.fetch(pathname)).text();
    if (!html.includes("data-further-reading")) {
      continue;
    }
    pagesWithContents++;
    // steerdown emit writes a page's data at the page's path under /steerdown, as index.json.
    const dataPath = `/steerdown${pathname}index.json`;
    const response = await server.fetch(dataPath);
    if (response.status !== 200 || !(response.headers.get("Content-Type") ?? "").includes("application/json")) {
      missing.push(dataPath);
      continue;
    }
    const data = (await response.json()) as { targets: Array<[string, string, string]> };
    for (const [url] of data.targets) {
      const [targetPath, fragment] = url.split("#");
      const targetHtml = await (await server.fetch(targetPath!)).text();
      if (fragment && !targetHtml.includes(`id="${fragment}"`)) {
        broken.push(`${pathname} -> ${url}`);
      }
    }
  }
  expect(pagesWithContents).toBeGreaterThan(0);
  expect(missing).toEqual([]);
  expect(broken).toEqual([]);
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

test("pricing preview is a 1200 by 630 PNG linked by pricing metadata", async () => {
  const html = await (await server.fetch("/pricing")).text();
  const image = html.match(/property="og:image" content="([^"]+)"/)?.[1];
  const twitterImage = html.match(/name="twitter:image" content="([^"]+)"/)?.[1];
  expect(image).toBe("https://zinn.sh/social/pricing.png");
  expect(twitterImage).toBe(image);
  const alt = html.match(/property="og:image:alt" content="([^"]+)"/)?.[1];
  const twitterAlt = html.match(/name="twitter:image:alt" content="([^"]+)"/)?.[1];
  expect(alt).toContain(sizeLabel(pricingTotals.download));
  expect(alt).toContain("zinn.sh/pricing");
  expect(twitterAlt).toBe(alt);
  await expectSocialImage("/social/pricing.png");
});

test("task blame preview is a 1200 by 630 PNG linked by task blame metadata", async () => {
  const html = await (await server.fetch("/docs/blame")).text();
  const image = html.match(/property="og:image" content="([^"]+)"/)?.[1];
  const twitterImage = html.match(/name="twitter:image" content="([^"]+)"/)?.[1];
  expect(image).toBe("https://zinn.sh/social/blame.png");
  expect(twitterImage).toBe(image);
  const alt = html.match(/property="og:image:alt" content="([^"]+)"/)?.[1];
  const twitterAlt = html.match(/name="twitter:image:alt" content="([^"]+)"/)?.[1];
  expect(alt).toContain("git blame, but for your task board");
  expect(alt).toContain("zinn.sh/docs/blame");
  expect(twitterAlt).toBe(alt);
  await expectSocialImage("/social/blame.png");
});

test("agent setup prompt uses the installation command and supported runtime", async () => {
  for (const command of [
    installCommand,
    "node --version",
    "zinn --version",
    "zinn skill install",
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
  rexTheme.path.slice(1),
  firefoxTheme.path.slice(1),
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

test("docs pages tag successful command copies and Markdown opens", async () => {
  const html = await (await server.fetch("/docs/installation")).text();
  expect(html).toContain('data-copy-event="command-copy"');
  expect(html).toMatch(/data-copy-event-target="[^"]+"/);
  expect(html).toMatch(/data-copy-event-kind="(command|code)"/);
  expect(html).toContain('data-site-event="markdown-open"');
});

test("performance flow tabs carry the flow event name and fixed flow data", async () => {
  const html = await (await server.fetch("/performance")).text();
  for (const flow of ["read", "write", "install"]) {
    const tab = html.match(new RegExp(`<button\\b[^>]*data-flow="${flow}"[^>]*>`))?.[0];
    expect(tab).toBeDefined();
    expect(tab).toContain('data-site-event="performance-flow"');
    expect(tab).toContain(`data-site-event-flow="${flow}"`);
  }
});

test("theme pages tag downloads and the Firefox page names each Add-ons target", async () => {
  const opencode = await (await server.fetch(opencodeTheme.path)).text();
  expect(opencode).toContain('data-site-event="theme-download"');
  expect(opencode).toContain('data-site-event-theme="opencode"');

  const rex = await (await server.fetch(rexTheme.path)).text();
  expect(rex).toContain('data-site-event="theme-download"');
  expect(rex).toContain('data-site-event-theme="rex-dark"');
  expect(rex).toContain('data-site-event-theme="rex-light"');
});

test("the integration gallery, Markdown index and llms.txt list the same detail pages in order", async () => {
  const hubMarkdownPath = markdownTwinPath(integrationsHub.path);
  const responses = await Promise.all([
    server.fetch(integrationsHub.path),
    server.fetch(hubMarkdownPath),
    server.fetch("/llms.txt"),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  const [html, markdown, discovery] = await Promise.all(
    responses.map((response) => response.text()),
  );

  const detailPaths = integrations.map(({ path }) => path);
  const isIntegrationDetail = (path: string) => path.startsWith(`${integrationsHub.path}/`);
  const main = html!.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";
  const galleryPaths = [...main.matchAll(/<a\b[^>]*href="([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter(isIntegrationDetail);
  // Each section starts its link paragraph with the detail page, followed by any downloads.
  const markdownPaths = [...markdown!.matchAll(/^\[[^\]]+\]\(https:\/\/zinn\.sh([^\)]+)\)/gm)]
    .map((match) => match[1]!)
    .filter(isIntegrationDetail);
  const discoveryPaths = [...discovery!.matchAll(/^- \[[^\]]+\]\(https:\/\/zinn\.sh([^\)]+)\)/gm)]
    .map((match) => match[1]!)
    .filter((path) => path === hubMarkdownPath || isIntegrationDetail(path));
  expect(galleryPaths).toEqual(detailPaths);
  expect(markdownPaths).toEqual(detailPaths);
  expect(discoveryPaths).toEqual([hubMarkdownPath, ...detailPaths.map(markdownTwinPath)]);
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

test("Rex theme page and its Markdown twin offer both downloadable theme files", async () => {
  const index = await server.fetch("/integrations");
  expect(index.status).toBe(200);
  expect(await index.text()).toContain(`href="${rexTheme.path}"`);

  const response = await server.fetch(rexTheme.path);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain(`rel="canonical" href="https://zinn.sh${rexTheme.path}/"`);
  expect(html).toContain("data-rex-figure");
  expect(html).toContain("data-capture-surface");
  expect(html).toContain("data-capture-annotations");
  expect(html).toContain('data-rex-mode="dark"');
  expect(html).toContain('data-rex-mode="light"');
  for (const scene of rexScenes) {
    expect(html).toContain(`data-rex-tab="${scene.id}"`);
    expect(html).toContain(`data-capture-annotation-line="${scene.id}"`);
    expect(html).toContain(`data-capture-annotation-label="${scene.id}"`);
  }
  expect(html).toContain(rexScenes[0]!.images.dark!);

  const markdownResponse = await server.fetch(`${rexTheme.path}.md`);
  expect(markdownResponse.status).toBe(200);
  expect(markdownResponse.headers.get("Content-Type")).toContain("text/markdown");
  const markdown = await markdownResponse.text();

  for (const scene of rexScenes) {
    for (const url of Object.values(scene.images)) {
      expect(markdown).toContain(url!);
    }
  }

  for (const downloadPath of Object.values(rexTheme.downloads)) {
    expect(html).toContain(`href="${downloadPath}"`);
    expect(markdown).toContain(downloadPath);

    const fileName = downloadPath.slice(downloadPath.lastIndexOf("/") + 1);
    const download = await server.fetch(downloadPath);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toContain("text/plain");
    expect(download.headers.get("Content-Disposition")).toContain(`filename="${fileName}"`);
    expect(await download.text()).toBe(
      await Bun.file(join(docsDirectory, `../integrations/rex/theme/${fileName}`)).text(),
    );
  }
});

test("Firefox theme page presents both add-on listings with Halftone first", async () => {
  const index = await server.fetch("/integrations");
  expect(index.status).toBe(200);
  const indexHtml = await index.text();
  expect(indexHtml).toContain(`href="${firefoxTheme.path}"`);
  expect(indexHtml).toContain(firefoxTheme.themes[0]!.image);

  const response = await server.fetch(firefoxTheme.path);
  expect(response.status).toBe(200);
  const html = await response.text();
  const [halftone, lattice] = firefoxTheme.themes;

  expect(html).toContain(`rel="canonical" href="https://zinn.sh${firefoxTheme.path}/"`);
  expect(html).toContain('rel="alternate" type="text/markdown"');
  expect(html).toContain(firefoxTheme.minimumVersion);
  for (const theme of firefoxTheme.themes) {
    expect(html).toContain(theme.addonUrl);
    expect(html).toContain(theme.image);
    expect(html).toContain(theme.name);
  }
  expect(html.indexOf(halftone.addonUrl)).toBeLessThan(html.indexOf(lattice!.addonUrl));

  const markdownResponse = await server.fetch(`${firefoxTheme.path}.md`);
  expect(markdownResponse.status).toBe(200);
  expect(markdownResponse.headers.get("Content-Type")).toContain("text/markdown");
  const markdown = await markdownResponse.text();
  for (const theme of firefoxTheme.themes) {
    expect(markdown).toContain(theme.addonUrl);
    expect(markdown).toContain(theme.image);
    expect(markdown).toContain(theme.name);
  }
  expect(markdown.indexOf(halftone.addonUrl)).toBeLessThan(markdown.indexOf(lattice!.addonUrl));
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
  expect(html).toContain("opencode.json");
  expect(html).toContain("cli.json");
  expect(html).toContain("ZINN_THREAD_ID");
  const markdown = await server.fetch(`${opencodeInspector.path}.md`);
  expect(markdown.status).toBe(200);
  expect(markdown.headers.get("Content-Type")).toContain("text/markdown");
  const text = await markdown.text();
  expect(text).toContain(opencodeInspector.package);
  expect(text).toContain(opencodeInspector.verifiedVersion);
  expect(text).toContain(opencodeInspector.minimumCliVersion);
  expect(text).toContain("opencode.json");
  expect(text).toContain("cli.json");
  expect(text).toContain("ZINN_THREAD_ID");
  const pageText = visibleText(html);
  const plainTail = (value: string) => value.split("`").at(-1)!.trim();
  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  for (const section of inspectorSections) {
    expect(pageText).toContain(section.heading);
    expect(text).toContain(`## ${section.heading}`);
  }
  for (const option of opencodeInspector.options) {
    expect(html).toContain(`<code>${escapeHtml(option.name)}</code>`);
    expect(html).toContain(`<code>${escapeHtml(option.default)}</code>`);
    expect(text).toContain(`\`${option.name}\``);
    expect(text).toContain(`\`${option.default}\``);
    expect(pageText).toContain(plainTail(option.behavior));
    expect(text).toContain(option.behavior);
  }
  for (const annotation of desktopBottomSlot.annotations) {
    expect(html).toContain(annotation.label);
    expect(html).toContain(annotation.text);
    expect(text).toContain(`**${annotation.label}.** ${annotation.text}`);
  }
  for (const config of [inspectorPluginConfig.server, inspectorPluginConfig.tui]) {
    expect(html).toContain(escapeHtml(config));
    expect(text).toContain(config);
  }
  for (const range of [
    opencodeInspector.installRange,
    opencodeInspector.installLine,
    opencodeInspector.openCodeRange,
  ]) {
    expect(pageText).toContain(range);
    expect(text).toContain(range);
  }
});
