import type { APIRoute } from "astro";

import { getReleases } from "../config/changelog";

const intro =
  "Notable changes to Zinn and its integrations. Each CLI release names the core version it includes, and integrations release on their own versions. **Breaking** changes include the action needed when upgrading.";

export const GET: APIRoute = async () => {
  const releases = await getReleases();
  const sections = releases.map(({ heading, name, date, packages, entry }) => {
    const title = name ? `${heading} ${name}` : heading;
    const packageLinks = packages.map(({ label, url }) => `[${label}](${url})`).join(" | ");

    return `## ${title} - ${date}\n\n${packageLinks}\n\n${entry.body?.trim()}`;
  });

  return new Response(`# CHANGELOG\n\n${intro}\n\n${sections.join("\n\n")}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
