import type { APIRoute } from "astro";
import { firefoxTheme } from "../config/firefox-theme";
import { opencodeInspector } from "../config/opencode-inspector";
import { opencodeTheme } from "../config/opencode-theme";
import { rexTheme } from "../config/rex-theme";

export const GET: APIRoute = () =>
  new Response(
    `# Integrations

Integrations and themes maintained by Zinn.

## Claude Code

Task keys with their status in Claude's replies, a task and board pane, and session identity for Zinn's activity log.

[View Claude Code setup](https://zinn.sh/integrations/claude-code) for installation, the pane, options, identity variables, updates and removal.

## OpenCode task inspector

${opencodeInspector.description}

[View the inspector](https://zinn.sh${opencodeInspector.path}) for setup, options, compatibility, update and removal.

## Codex

Local task inspection and optional execution-identity hooks alongside a Codex desktop chat.

[View Codex setup](https://zinn.sh/integrations/codex) for the source build, database selection, hook trust, privacy, compatibility and removal.

## OpenCode theme

${opencodeTheme.introduction}

Verified with OpenCode ${opencodeTheme.verifiedVersion}.

[View theme](https://zinn.sh${opencodeTheme.path}) or [download zinn.json](https://zinn.sh${opencodeTheme.download}).

## Rex theme

The Zinn color palette for [Rex](${rexTheme.site}), with light and dark appearances.

Verified with ${rexTheme.verifiedVersion}.

[View theme](https://zinn.sh${rexTheme.path}) or [download zinn-dark](https://zinn.sh${rexTheme.downloads.dark}) and [zinn-light](https://zinn.sh${rexTheme.downloads.light}).

## Firefox theme

${firefoxTheme.introduction}

[View theme](https://zinn.sh${firefoxTheme.path}) or install [Zinn Halftone](${firefoxTheme.themes[0]!.addonUrl}) or [Zinn Lattice](${firefoxTheme.themes[1]!.addonUrl}) from Mozilla Add-ons.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
