import { expect, test } from "bun:test";
import { join } from "node:path";

import { orderResults } from "../src/components/search/pagefind";
import { siteBuildDirectory } from "./build-directories";

const baseUrl = process.env.SITE_TEST_URL;
if (!baseUrl) {
  throw new Error("Run bun run --cwd docs test to start the local Cloudflare server.");
}

interface SearchPage {
  url: string;
  content: string;
  meta: { title: string };
  sub_results: { url: string; title: string }[];
}

const pagefind = await import(join(siteBuildDirectory, "pagefind/pagefind.js"));
await pagefind.options({ basePath: new URL("/pagefind/", baseUrl).href, noWorker: true });

const pathOf = (url: string) => url.replace(baseUrl, "");

// A null query returns every indexed page. Pagefind prefixes URLs with the origin of its absolute basePath.
async function search(query: string | null): Promise<SearchPage[]> {
  const { results } = await pagefind.search(query);
  const pages: SearchPage[] = await Promise.all(
    results.map((result: { data(): Promise<SearchPage> }) => result.data()),
  );
  return pages.map((page) => ({
    ...page,
    url: pathOf(page.url),
    sub_results: page.sub_results.map((section) => ({
      url: pathOf(section.url),
      title: section.title,
    })),
  }));
}

test.each(["/pagefind/pagefind.js", "/pagefind/pagefind-worker.js"])(
  "%s is served as JavaScript",
  async (path) => {
    const response = await fetch(new URL(path, baseUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("javascript");
  },
);

test("built pages hold no unresolved dynamic import", async () => {
  const html = await (await fetch(new URL("/docs/cli/", baseUrl))).text();
  expect(html).toContain("/pagefind/pagefind.js");
  expect(html).not.toContain("__VITE_PRELOAD__");
});

test.each([
  ["blame", "/docs/blame/"],
  ["backup", "/docs/data/"],
  ["hooks", "/docs/hooks/"],
  ["--json", "/docs/scripting/"],
  ["telemetry", "/docs/data/telemetry/"],
])("searching %s ranks %s first", async (query, url) => {
  const [first] = orderResults(query, await search(query));
  expect(first?.url).toBe(url);
});

test("a result links to the heading that matched", async () => {
  const core = (await search("blame")).find((page) => page.url === "/docs/core/blame/");
  expect(core?.sub_results.map((section) => section.url)).toContain("/docs/core/blame/#read-attribution");
});

test("a query naming a section heading leads with that page", async () => {
  const [first] = orderResults("task key reuse", await search("task key reuse"));
  expect(first?.url).toBe("/docs/data/");
  expect(first?.sub_results.map((section) => section.url)).toContain("/docs/data/#task-key-reuse");
});

test("the index holds public HTML pages only", async () => {
  const urls = (await search(null)).map((page) => page.url);
  expect(urls).toContain("/");
  expect(urls).toContain("/changelog/");
  expect(urls.filter((url) => url.includes("404") || url.endsWith(".md"))).toEqual([]);
});

test.each(["Failed to copy", "Copy as Markdown", "Enlarged screenshot"])(
  "indexed text leaves out %s",
  async (controlText) => {
    const pagesWithText = (await search(null)).filter((page) => page.content.includes(controlText));
    expect(pagesWithText.map((page) => page.url)).toEqual([]);
  },
);

// Every page's header links to the changelog and its footer to Pricing, so a match on those would return every page.
test.each(["CHANGELOG", "Pricing"])(
  "the site's header and footer do not make %s match every page",
  async (linkText) => {
    const pagesWithLink = await search(linkText);
    expect(pagesWithLink.length).toBeLessThan((await search(null)).length);
  },
);

test("CLI navigation does not become indexed reading content", async () => {
  const references = (await search(null)).filter((page) => page.url.startsWith("/docs/cli/"));
  expect(references.length).toBeGreaterThan(1);
  for (const page of references) {
    expect(page.content).not.toContain("On this page");
    expect(page.content).not.toContain("All CLI topics");
  }
});

test.each([
  ["command aliases", "/docs/cli/help/#command-aliases"],
  ["who am i", "/docs/cli/identity/#who-am-i"],
])("searching %s reaches its CLI section", async (query, url) => {
  const sections = (await search(query)).flatMap((page) => page.sub_results.map((section) => section.url));
  expect(sections).toContain(url);
});
