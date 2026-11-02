import type { APIRoute } from "astro";
import { opencodeInspector } from "../config/opencode-inspector";
import { opencodeTheme } from "../config/opencode-theme";
import { rexTheme } from "../config/rex-theme";

export const GET: APIRoute = () =>
  new Response(
    `# Integrations

Themes and integrations maintained by Zinn.

## OpenCode theme

${opencodeTheme.introduction}

Verified with OpenCode ${opencodeTheme.verifiedVersion}.

[View theme](https://zinn.sh${opencodeTheme.path}) or [download zinn.json](https://zinn.sh${opencodeTheme.download}).

## Rex theme

The Zinn color palette for [Rex](${rexTheme.site}), with light and dark appearances.

Verified with ${rexTheme.verifiedVersion}.

[View theme](https://zinn.sh${rexTheme.path}) or [download zinn-dark](https://zinn.sh${rexTheme.downloads.dark}) and [zinn-light](https://zinn.sh${rexTheme.downloads.light}).

## OpenCode task inspector

${opencodeInspector.description}

[View the inspector](https://zinn.sh${opencodeInspector.path}) for setup, options, compatibility, update and removal.

## Codex

Local task inspection and optional execution-identity hooks alongside a Codex desktop chat.

[View Codex setup](https://zinn.sh/integrations/codex) for the source build, database selection, hook trust, privacy, compatibility and removal.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
