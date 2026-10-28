import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

import { pageDate } from "./config/page-date";

/**
 * File paths mirror the URLs
 * `content/docs/installation.mdx` serves `/docs/installation`
 * `content/about.mdx` serves `/about`
 * An `index.mdx` serves its folder, so `content/docs/index.mdx` serves `/docs`
 */
export const collections = {
  prose: defineCollection({
    loader: glob({ pattern: "**/*.mdx", base: "./src/content" }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      lastUpdated: pageDate.optional(),
    }),
  }),
};
