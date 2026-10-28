import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { markdownBody } from "../markdown/markdown-body";

export const getStaticPaths = (async () => {
  const entries = await getCollection("prose");

  return entries.map((entry) => {
    const markdown = entry.body ? markdownBody(entry.body) : entry.body;
    return {
      params: { slug: entry.id },
      props: {
        markdown: entry.data.lastUpdated
          ? markdown?.replace(/^(# .+)$/m, `$1\n\nLast updated: ${entry.data.lastUpdated}`)
          : markdown,
      },
    };
  });
}) satisfies GetStaticPaths;

// MDX entry bodies arrive trimmed, so end the file with a newline as its source does.
export const GET: APIRoute = ({ props }) =>
  new Response(`${props.markdown}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
