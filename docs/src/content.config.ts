import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

import { pageDate } from "./config/page-date";

const page = z.object({
  title: z.string(),
  description: z.string(),
  lastUpdated: pageDate.optional(),
});

/**
 * Folders mirror the URLs
 * `docs/installation.mdx` serves `/docs/installation`
 * `pages/about.mdx` serves `/about`
 */
export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.mdx", base: "./src/content/docs" }),
    schema: page,
  }),
  pages: defineCollection({
    loader: glob({ pattern: "**/*.mdx", base: "./src/content/pages" }),
    schema: page,
  }),
};
