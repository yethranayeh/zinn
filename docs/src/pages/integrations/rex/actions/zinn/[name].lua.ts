import type { APIRoute, GetStaticPaths } from "astro";
import { rexActions } from "../../../../../config/rex-actions";

const sources = import.meta.glob<string>("../../../../../../../integrations/rex/zinn/*.lua", {
  query: "?raw",
  import: "default",
  eager: true,
});

export const getStaticPaths = (() =>
  rexActions.files.map((file) => {
    const source = Object.entries(sources).find(([path]) => path.endsWith(`/${file}`))?.[1];
    if (source === undefined) {
      throw new Error(`integrations/rex/zinn/${file} is missing`);
    }

    return { params: { name: file.replace(/\.lua$/, "") }, props: { source } };
  })) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(props.source, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
