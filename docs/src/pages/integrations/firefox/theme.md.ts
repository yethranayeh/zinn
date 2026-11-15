import type { APIRoute } from "astro";
import { firefoxTheme } from "../../../config/firefox-theme";
import { projectLinks } from "../../../config/site";

const [halftone, lattice] = firefoxTheme.themes;

export const GET: APIRoute = () =>
  new Response(
    `# ${firefoxTheme.title}

${firefoxTheme.introduction}

Verified with ${firefoxTheme.verifiedVersion}.

## Textures

Both themes use the same palette. They differ in the texture across the tab strip and toolbar.

${firefoxTheme.themes
  .map(
    (theme) =>
      `### ${theme.name}

${theme.description}

![${theme.imageAlt}](${theme.image})

[Install ${theme.name}](${theme.addonUrl}) from Mozilla Add-ons.`,
  )
  .join("\n\n")}

## Installation

Both themes install from Mozilla Add-ons. Firefox applies the one you choose right away.

1. Open [Zinn Halftone](${halftone.addonUrl}) or [Zinn Lattice](${lattice.addonUrl}) on Mozilla Add-ons.
2. Choose Add to Firefox.
3. Open \`about:addons\` and select Themes to switch or remove a theme.

Requires ${firefoxTheme.minimumVersion} or later. The theme follows the system light and dark appearance.

[Theme source](${projectLinks.github}/tree/main/integrations/firefox/theme) · [All integrations](https://zinn.sh/integrations)
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
