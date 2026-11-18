import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const baseUrl = process.env.SITE_TEST_URL;
if (!baseUrl) {
  throw new Error("Run bun run --cwd docs test to start the local Cloudflare server.");
}
const directory = join(import.meta.dir, "../src/content/docs/cli");
const topics = (await readdir(directory))
  .filter((file) => file.endsWith(".mdx"))
  .map((file) => `/docs/cli/${file.replace(/\.mdx$/, "")}`);
const pages = ["/docs/cli", ...topics];
const responses = new Map<string, Promise<string>>();

function htmlAt(path: string) {
  let result = responses.get(path);
  if (!result) {
    result = fetch(new URL(path, baseUrl)).then(async (response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      return response.text();
    });
    responses.set(path, result);
  }
  return result;
}

test.each(topics)("%s has its CLI parent in the visible breadcrumb", async (path) => {
  const html = await htmlAt(path);
  const breadcrumb = html.match(/<nav\b[^>]*aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  const links = [...breadcrumb!.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  expect(links).toEqual(["/docs/", "/docs/cli/", `${path}/`]);
});

test.each(pages)("%s links every section from both contents controls", async (path) => {
  const html = await htmlAt(path);
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)![1]!;
  const sections = [...article.matchAll(/<h[23]\b[^>]*id="([^"]+)"/g)].map((match) => match[1]);
  const links = [...html.matchAll(/href="#([^"]+)"\s+data-section-link/g)].map((match) => match[1]);
  expect(links).toEqual([...sections, ...sections]);
});

test("the CLI hub indexes its current topic pages and sections in HTML and Markdown", async () => {
  const hub = await htmlAt("/docs/cli");
  const index = hub.match(/<details\b[^>]*data-topic-index[^>]*>([\s\S]*?)<\/details>/)![1]!;
  const entries = await Promise.all(
    topics.map(async (path) => {
      const html = await htmlAt(path);
      const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)![1]!;
      const title = article.match(/<h1\b[^>]*>([^<]+)<\/h1>/)![1]!.trim();
      const headings = [...article.matchAll(/<h2\b[^>]*id="([^"]+)"[^>]*>([^<]+)<\/h2>/g)];
      return {
        title,
        links: [
          { title, path },
          ...headings.map((match) => ({ title: match[2]!.trim(), path: `${path}#${match[1]}` })),
        ],
      };
    }),
  );
  entries.sort((first, second) => first.title.localeCompare(second.title));
  const expected = entries.flatMap(({ links }) => links);
  const visible = [...index.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(
    (match) => ({ title: match[2]!.trim(), path: match[1]! }),
  );
  expect(visible).toEqual(expected);

  const markdown = await (await fetch(new URL("/docs/cli.md", baseUrl))).text();
  const markdownIndex = markdown.split("## All CLI topics\n")[1]!;
  const markdownLinks = [...markdownIndex.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => ({
    title: match[1]!,
    path: match[2]!.replace(/\.md(?=#|$)/, ""),
  }));
  expect(markdownLinks).toEqual(expected);
  expect(markdown).not.toContain("<TopicIndex");
});

test.each(pages)("%s has working documentation links in its Markdown twin", async (path) => {
  const response = await fetch(new URL(`${path}.md`, baseUrl));
  expect(response.status).toBe(200);
  const markdown = await response.text();
  const links = [...markdown.matchAll(/\]\((\/docs[^)]*)\)/g)].map((match) => match[1]!);
  for (const link of links) {
    const [target, fragment] = link.split("#");
    expect(target).toEndWith(".md");
    const targetResponse = await fetch(new URL(target!, baseUrl));
    expect(targetResponse.status).toBe(200);
    expect(targetResponse.headers.get("Content-Type")).toContain("text/markdown");
    if (fragment) {
      expect(await htmlAt(target!.replace(/\.md$/, ""))).toContain(`id="${fragment}"`);
    }
  }
});
