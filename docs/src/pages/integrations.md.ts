import type { APIRoute } from "astro";
import { opencodeInspector } from "../config/opencode-inspector";
import { opencodeTheme } from "../config/opencode-theme";

export const GET: APIRoute = () =>
  new Response(
    `# Integrations

Themes and integrations maintained by Zinn.

## OpenCode theme

${opencodeTheme.introduction}

Verified with OpenCode ${opencodeTheme.verifiedVersion}.

[View theme](https://zinn.sh${opencodeTheme.path}) or [download zinn.json](https://zinn.sh${opencodeTheme.download}).

## OpenCode task inspector

${opencodeInspector.description}

[View the inspector](https://zinn.sh${opencodeInspector.path}) for setup, options, compatibility, update and removal.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
