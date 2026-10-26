import type { APIRoute } from "astro";
import { opencodeScenes, opencodeTheme } from "../../../config/opencode-theme";
import { projectLinks } from "../../../config/site";

export const GET: APIRoute = () =>
  new Response(
    `# ${opencodeTheme.title}

${opencodeTheme.introduction}

Verified with OpenCode ${opencodeTheme.verifiedVersion}.

## Gallery

${opencodeScenes
  .map(
    (scene) =>
      `### ${scene.label}\n\n${Object.entries(scene.images)
        .map(([appearance, source]) => `![${scene.label}, ${appearance} mode](${source})`)
        .join("\n\n")}`,
  )
  .join("\n\n")}

## Installation

Download the theme file and add it to OpenCode’s themes directory.

1. [Download zinn.json](https://zinn.sh${opencodeTheme.download}) and save it in \`~/.config/opencode/themes/\`.
2. Open \`/themes\` in OpenCode.
3. Select \`zinn\`.

OpenCode uses the filename as the theme name. Keep it \`zinn.json\` and choose light, dark or system mode in OpenCode’s settings.

\`\`\`sh
${opencodeTheme.commands.join("\n")}
\`\`\`

[Theme source](${projectLinks.github}/tree/main/integrations/opencode/theme) · [All integrations](https://zinn.sh/integrations)
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
