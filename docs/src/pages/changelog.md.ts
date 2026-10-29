import type { APIRoute } from "astro";

import { getReleases, npmPackageUrl } from "../config/changelog";

const intro =
  "Notable changes to Zinn. Each CLI release names the core version it includes. **Breaking** changes include the action needed when upgrading.";

export const GET: APIRoute = async () => {
  const releases = await getReleases();
  const sections = releases.map(({ data, body }) => {
    const name = data.name ? ` ${data.name}` : "";
    const packages = `[CLI ${data.cli}](${npmPackageUrl("cli", data.cli)}) | [Core ${data.core}](${npmPackageUrl("core", data.core)})`;

    return `## ${data.version}${name} - ${data.date}\n\n${packages}\n\n${body?.trim()}`;
  });

  return new Response(`# CHANGELOG\n\n${intro}\n\n${sections.join("\n\n")}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
