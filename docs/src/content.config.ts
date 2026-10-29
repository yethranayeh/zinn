import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

import { pageDate } from "./config/page-date";

const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

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
  // One file per release. src/pages/changelog.astro lists them.
  releases: defineCollection({
    loader: glob({ pattern: "*.mdx", base: "./src/releases" }),
    schema: z.object({
      version: semver,
      name: z.string().optional(),
      date: z.iso.date(),
      cli: semver,
      core: semver,
    }),
  }),
};
