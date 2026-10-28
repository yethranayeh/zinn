import type { CollectionEntry } from "astro:content";

// The docs index entry serves `/docs` and every other entry serves `/docs/<id>`.
export const docsSlug = (entry: CollectionEntry<"docs">) =>
  entry.id === "index" ? undefined : entry.id;

// Sections that show breadcrumbs: the first URL segment maps to the section name.
export const sectionNames: Record<string, string> = {
  docs: "Docs",
  integrations: "Integrations",
};
