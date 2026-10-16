import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const page = z.object({
  title: z.string(),
  description: z.string(),
});

/**
 * Folders mirror the URLs
 * `docs/installation.mdx` serves `/docs/installation`
 * `pages/about.mdx` serves `/about`
 */
export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.mdx", base: "./src/content/docs" }),
    schema: page.extend({ breadcrumb: z.string().optional() }),
  }),
  pages: defineCollection({
    loader: glob({ pattern: "**/*.mdx", base: "./src/content/pages" }),
    schema: page,
  }),
};
