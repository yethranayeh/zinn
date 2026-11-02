import type { APIRoute } from "astro";
import { projectLinks } from "../config/site";

export const GET: APIRoute = () =>
  new Response(
    `# Zinn

> Zinn is an Experimental kanban CLI and task manager for the terminal. It stores projects and tasks in a local SQLite database and requires Node.js 24.15.0 or newer.

When to use Zinn: track development work locally, carry task scope and progress between sessions, or read and update a project's board from scripts and agents using the CLI's JSON output. Run Zinn on the user's machine with shell access; start with \`zinn --help\` and read the CLI reference before changing tasks.

## When to use

- [CLI workflow](https://zinn.sh/docs/cli.md): Track local development work with projects, tasks and progress comments; read and update a board with JSON output. Start with \`zinn --help\` and inspect each command's help before calling it.

## Documentation

- [Zinn overview](https://zinn.sh/index.md): Product, installation, project workflow and local storage.
- [Documentation index](https://zinn.sh/docs.md): Guide to installing Zinn, starting a workflow, and finding reference pages.
- [Installation](https://zinn.sh/docs/installation.md): Requirements, installing, upgrading and uninstalling the CLI and core, and running them on Bun.
- [Quick start](https://zinn.sh/docs/quick-start.md): Create a project, add a task, and move it through the board.
- [CLI reference](https://zinn.sh/docs/cli.md): Project, task, label, relation, comment, and activity commands.
- [Settings](https://zinn.sh/docs/settings.md): Data-directory selection, default projects, and store inspection.
- [Scripting and JSON output](https://zinn.sh/docs/scripting.md): JSON contracts, command discovery, and confirmations.
- [Hooks](https://zinn.sh/docs/hooks.md): Commands that run after a saved change, with activity records on stdin.
- [Data and backups](https://zinn.sh/docs/data.md): Local storage, backups, restores, and database compatibility.
- [Core library](https://zinn.sh/docs/core.md): TypeScript setup, shared guarantees, and database compatibility.
- [Changelog](https://zinn.sh/changelog.md): Release changes, bundled core versions and breaking changes.

## Project information

- [Integrations](https://zinn.sh/integrations.md): Themes and integrations maintained by Zinn.
- [OpenCode theme](https://zinn.sh/integrations/opencode/theme.md): Screenshots, download and setup for the Zinn theme in light and dark.
- [OpenCode task inspector](https://zinn.sh/integrations/opencode/inspector.md): Native package setup, task marks, compatibility, update and removal.
- [Codex integration](https://zinn.sh/integrations/codex.md): Local task inspector, source build, explicit database selection, hook trust, identity and privacy settings.
- [About Zinn](https://zinn.sh/about.md): Scope, Experimental status, source and license.
- [Contact](https://zinn.sh/contact.md): Public issue reporting and support information.
- [Privacy](https://zinn.sh/privacy.md): Website hosting and analytics, local CLI data and external links.
- [Pricing](https://zinn.sh/pricing.md): What Zinn costs in bytes, downloaded and on disk, and what a command costs to run.

## Optional

- [Source repository](${projectLinks.github}): Implementation, releases and issue tracker.
- [CLI package](${projectLinks.npm}): Published installation package.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
