import type { APIRoute } from "astro";

import { integrationsHub } from "../config/integrations-hub";
import { integrations } from "../config/integrations";
import { minimumNodeVersion, projectLinks } from "../config/site";
import { markdownTwinPath } from "../markdown/twin-path";

const integrationLinks = [
  integrationsHub,
  ...integrations.map(({ path, host, label, discovery }) => ({
    path,
    title: discovery.title ?? label ?? host,
    description: discovery.description,
  })),
]
  .map(
    ({ path, title, description }) =>
      `- [${title}](https://zinn.sh${markdownTwinPath(path)}): ${description}`,
  )
  .join("\n");

export const GET: APIRoute = () =>
  new Response(
    `# Zinn

> Zinn is an Experimental kanban CLI and task manager for the terminal. It stores projects and tasks in a local SQLite database and requires Node.js ${minimumNodeVersion} or newer.

When to use Zinn: track development work locally, carry task scope and progress between sessions, or read and update a project's board from scripts and agents using the CLI's JSON output. Run Zinn on the user's machine with shell access; start with \`zinn --help\` and read the CLI reference before changing tasks.

## When to use

- [CLI workflow](https://zinn.sh/docs/cli.md): Track local development work with projects, tasks and progress comments; read and update a board with JSON output. Start with \`zinn --help\` and inspect each command's help before calling it.

## Documentation

- [Zinn overview](https://zinn.sh/index.md): Product, installation, project workflow and local storage.
- [Documentation index](https://zinn.sh/docs.md): Guide to installing Zinn, starting a workflow, and finding reference pages.
- [Installation](https://zinn.sh/docs/installation.md): Requirements, installing, upgrading and uninstalling the CLI and core, and running them on Bun.
- [Quick start](https://zinn.sh/docs/quick-start.md): Create a project, add a task, and move it through the board.
- [CLI reference](https://zinn.sh/docs/cli.md): Project, task, label, relation, comment, and activity commands.
- [Task blame](https://zinn.sh/docs/blame.md): Attribute a task's fields and description lines to the edits that set them, and to the person or program behind each edit.
- [Settings](https://zinn.sh/docs/settings.md): Data-directory selection, default projects, and store inspection.
- [Scripting and JSON output](https://zinn.sh/docs/scripting.md): JSON contracts, command discovery, and confirmations.
- [Hooks](https://zinn.sh/docs/hooks.md): Commands that run after a saved change, with activity records on stdin.
- [Data and backups](https://zinn.sh/docs/data.md): Local storage, backups, restores, and database compatibility.
- [Core library](https://zinn.sh/docs/core.md): TypeScript setup, shared guarantees, and database compatibility.
- [Changelog](https://zinn.sh/changelog.md): Release changes, bundled core versions and breaking changes.

## Project information

${integrationLinks}
- [About Zinn](https://zinn.sh/about.md): Scope, Experimental status, source and license.
- [Contact](https://zinn.sh/contact.md): Public issue reporting and support information.
- [Privacy](https://zinn.sh/privacy.md): Website hosting and analytics, local CLI data and external links.
- [Pricing](https://zinn.sh/pricing.md): What Zinn costs in bytes, downloaded and on disk, and what a command costs to run.
- [Performance](https://zinn.sh/performance.md): Measured command times, memory, output and the path a command takes from an agent to SQLite and back.

## Optional

- [Source repository](${projectLinks.github}): Implementation, releases and issue tracker.
- [CLI package](${projectLinks.npm}): Published installation package.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
