import type { APIRoute } from "astro";
import { opencodeTheme } from "../config/opencode-theme";

export const GET: APIRoute = () =>
  new Response(
    `# Integrations

Themes and integrations maintained by Zinn.

## OpenCode theme

${opencodeTheme.introduction}

Verified with OpenCode ${opencodeTheme.verifiedVersion}.

[View theme](https://zinn.sh${opencodeTheme.path}) or [download zinn.json](https://zinn.sh${opencodeTheme.download}).
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
