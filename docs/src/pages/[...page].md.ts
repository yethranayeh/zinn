import type { APIRoute, GetStaticPaths } from "astro";

const pages = import.meta.glob<string>("./**/*.{md,mdx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Drops the frontmatter and, in MDX, the import and export lines that follow it.
const markdownBody = (source: string) =>
  source
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trimStart()
    .replace(/^(?:(?:import|export) .*\r?\n)+/, "")
    .trimStart();

export const getStaticPaths: GetStaticPaths = () =>
  Object.entries(pages).map(([path, source]) => ({
    params: {
      page: path
        .slice(2)
        .replace(/\.mdx?$/, "")
        .replace(/\/index$/, ""),
    },
    props: { markdown: markdownBody(source) },
  }));

export const GET: APIRoute = ({ props }) =>
  new Response(props.markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
