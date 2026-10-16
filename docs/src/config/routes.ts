import type { CollectionEntry } from "astro:content";

// The docs index entry serves `/docs` and every other entry serves `/docs/<id>`.
export const docsSlug = (entry: CollectionEntry<"docs">) =>
  entry.id === "index" ? undefined : entry.id;
