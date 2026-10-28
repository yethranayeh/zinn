import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { docsSlug } from "../config/routes";

// HTML-only elements are omitted from the twin. An aside keeps its label as a quoted note.
function markdownBody(body: string) {
  return body
    .replace(/^import AgentSetup from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^import Aside from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^\r?\n/, "")
    .replace(/^<AgentSetup \/>\r?\n\r?\n/m, "")
    .replace(
      /^<Aside\b[^>]*label=(['"])(.+?)\1[^>]*>[ \t]*\r?\n\r?\n([\s\S]*?)\r?\n\r?\n<\/Aside>[ \t]*\r?\n[ \t]*\r?\n/gm,
      (_match, _quote, label: string, content: string) => {
        const quoted = content
          .split(/\r?\n/)
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n");
        return `> **${label}**\n>\n${quoted}\n\n`;
      },
    );
}

export const getStaticPaths = (async () => {
  const pages = await getCollection("pages");
  const docs = await getCollection("docs");

  return [
    ...pages.map((entry) => {
      const markdown = entry.body ? markdownBody(entry.body) : entry.body;
      return {
        params: { page: entry.id },
        props: {
          markdown: entry.data.lastUpdated
            ? markdown?.replace(/^(# .+)$/m, `$1\n\nLast updated: ${entry.data.lastUpdated}`)
            : markdown,
        },
      };
    }),
    ...docs.map((entry) => ({
      params: { page: ["docs", docsSlug(entry)].filter(Boolean).join("/") },
      props: {
        markdown: entry.body ? markdownBody(entry.body) : entry.body,
      },
    })),
  ];
}) satisfies GetStaticPaths;

// MDX entry bodies arrive trimmed, so end the file with a newline as its source does.
export const GET: APIRoute = ({ props }) =>
  new Response(`${props.markdown}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
