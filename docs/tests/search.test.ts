import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

const docsDirectory = resolve(import.meta.dir, "..");
const baseUrl = process.env.SITE_TEST_URL;
if (!baseUrl) {
  throw new Error("Run bun run --cwd docs test to start the local Cloudflare server.");
}

interface SearchPage {
  url: string;
  content: string;
  sub_results: { url: string }[];
}

const pagefind = await import(join(docsDirectory, "dist/pagefind/pagefind.js"));
await pagefind.options({ basePath: new URL("/pagefind/", baseUrl).href, noWorker: true });

const pathOf = (url: string) => url.replace(baseUrl, "");

// A null query returns every indexed page. Pagefind prefixes URLs with the origin of its absolute basePath.
async function search(query: string | null): Promise<SearchPage[]> {
  const { results } = await pagefind.search(query);
  const pages: SearchPage[] = await Promise.all(results.map((result: { data(): Promise<SearchPage> }) => result.data()));
  return pages.map((page) => ({
    ...page,
    url: pathOf(page.url),
    sub_results: page.sub_results.map((section) => ({ url: pathOf(section.url) })),
  }));
}

test.each(["/pagefind/pagefind.js", "/pagefind/pagefind-worker.js"])("%s is served as JavaScript", async (path) => {
  const response = await fetch(new URL(path, baseUrl));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("javascript");
});

test("built pages hold no unresolved dynamic import", async () => {
  const html = await (await fetch(new URL("/docs/cli/", baseUrl))).text();
  expect(html).toContain("/pagefind/pagefind.js");
  expect(html).not.toContain("__VITE_PRELOAD__");
});

test.each([
  ["blame", "/docs/core/"],
  ["backup", "/docs/data/"],
  ["hooks", "/docs/hooks/"],
  ["--json", "/docs/scripting/"],
])("searching %s ranks %s first", async (query, url) => {
  const [first] = await search(query);
  expect(first?.url).toBe(url);
});

test("a result links to the heading that matched", async () => {
  const [first] = await search("blame");
  expect(first?.sub_results.map((section) => section.url)).toContain("/docs/core/#task-blame");
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
test.each(["CHANGELOG", "Pricing"])("the site's header and footer do not make %s match every page", async (linkText) => {
  const pagesWithLink = await search(linkText);
  expect(pagesWithLink.length).toBeLessThan((await search(null)).length);
});

test("the CLI reference's table of contents is not a result", async () => {
  const pages = await search("blame");
  const sections = pages.flatMap((page) => page.sub_results.map((section) => section.url));
  expect(sections).not.toContain("/docs/cli/#contents");
});
