import { getCollection, render } from "astro:content";

export async function getTopicIndex(parent: string) {
  const prefix = `${parent.replace(/^\/|\/$/g, "")}/`;
  const entries = await getCollection("prose", ({ id }) => id.startsWith(prefix));

  entries.sort((first, second) => first.data.title.localeCompare(second.data.title));

  return Promise.all(
    entries.map(async (entry) => {
      const { headings } = await render(entry);

      return {
        title: entry.data.title,
        path: `/${entry.id}`,
        headings: headings.filter(({ depth }) => depth === 2),
      };
    }),
  );
}
