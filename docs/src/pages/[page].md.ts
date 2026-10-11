import type { APIRoute, GetStaticPaths } from "astro";

const pages = import.meta.glob<string>("./*.md", { query: "?raw", import: "default", eager: true });

export const getStaticPaths: GetStaticPaths = () =>
  Object.entries(pages).map(([path, source]) => ({
    params: { page: path.slice(2, -3) },
    props: { markdown: source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart() },
  }));

export const GET: APIRoute = ({ props }) =>
  new Response(props.markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
