import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { docsSlug } from "../config/routes";

export const getStaticPaths = (async () => {
  const pages = await getCollection("pages");
  const docs = await getCollection("docs");

  return [
    ...pages.map((entry) => ({ params: { page: entry.id }, props: { markdown: entry.body } })),
    ...docs.map((entry) => ({
      params: { page: ["docs", docsSlug(entry)].filter(Boolean).join("/") },
      props: {
        // The setup button is an HTML action, so omit its MDX import and element.
        markdown: entry.body
          ?.replace(/^import AgentSetup from ["'][^"']+["'];\r?\n\r?\n/, "")
          .replace(/^<AgentSetup \/>\r?\n\r?\n/m, ""),
      },
    })),
  ];
}) satisfies GetStaticPaths;

// MDX entry bodies arrive trimmed, so end the file with a newline as its source does.
export const GET: APIRoute = ({ props }) =>
  new Response(`${props.markdown}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
