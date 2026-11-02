import type { APIRoute } from "astro";
import { rexTheme } from "../../../config/rex-theme";
import { projectLinks } from "../../../config/site";

export const GET: APIRoute = () =>
  new Response(
    `# ${rexTheme.title}

The Zinn color palette for [Rex](${rexTheme.site}), with light and dark appearances.

Verified with ${rexTheme.verifiedVersion}.

## Installation

Download both files and import them with the Rex CLI.

1. Download [zinn-dark](https://zinn.sh${rexTheme.downloads.dark}) and [zinn-light](https://zinn.sh${rexTheme.downloads.light}).
2. Import each file with \`rex do client.theme.import\`.
3. Import both files to fill the dark and light sides of the theme pair.

Rex uses the file name as the theme name and an import applies the theme immediately. With one app client connected, \`rex do\` picks it automatically. With more than one, add \`-C\` with the label from \`rex client ls\`. Switch the appearance mode to move between the two.

The files are in Ghostty's theme format, so they also work in Ghostty itself.

Rex's [settings reference](${rexTheme.importDocs}) covers Import Theme and the theme sheet.

\`\`\`sh
${rexTheme.commands.join("\n")}
\`\`\`

[Theme source](${projectLinks.github}/tree/main/integrations/rex/theme) · [All integrations](https://zinn.sh/integrations)
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
