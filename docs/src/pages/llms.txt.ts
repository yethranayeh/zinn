import type { APIRoute } from "astro";

import { integrationsHub } from "../config/integrations-hub";
import { integrations } from "../config/integrations";
import { minimumNodeVersion, projectLinks } from "../config/site";
import { markdownTwinPath } from "../markdown/twin-path";

function markdownUrl(path: string) {
  return `https://zinn.sh${markdownTwinPath(path)}`;
}

const integrationLinks = [
  integrationsHub,
  ...integrations.map(({ path, host, label, discovery }) => ({
    path,
    title: discovery.title ?? label ?? host,
    description: discovery.description,
  })),
]
  .map(({ path, title, description }) => `- [${title}](${markdownUrl(path)}): ${description}`)
  .join("\n");

export const GET: APIRoute = () =>
  new Response(
    `# Zinn

> Zinn is an Experimental kanban CLI and task manager for the terminal. It stores projects and tasks in a local SQLite database and requires Node.js ${minimumNodeVersion} or newer.

When to use Zinn: track development work locally, carry task scope and progress between sessions, or read and update a project's board from scripts and agents using the CLI's JSON output. Run Zinn on the user's machine with shell access; start with \`zinn --help\` and read the CLI reference before changing tasks.

## When to use

- [CLI workflow](${markdownUrl("/docs/cli")}): Track local development work with projects, tasks and progress comments; read and update a board with JSON output. Start with \`zinn --help\` and inspect each command's help before calling it.

## Documentation

- [Zinn overview](${markdownUrl("/")}): Product, installation, project workflow and local storage.
- [Documentation index](${markdownUrl("/docs")}): Guide to installing Zinn, starting a workflow, and finding reference pages.
- [Installation](${markdownUrl("/docs/installation")}): Requirements, installing, upgrading and uninstalling the CLI and core, and running them on Bun.
- [Quick start](${markdownUrl("/docs/quick-start")}): Create a project, add a task, and move it through the board.
- [CLI reference](${markdownUrl("/docs/cli")}): Project, task, label, relation, comment, and activity commands.
- [Task blame](${markdownUrl("/docs/blame")}): Attribute a task's fields and description lines to the edits that set them, and to the person or program behind each edit.
- [Settings](${markdownUrl("/docs/settings")}): Data-directory selection, default projects, and store inspection.
- [Scripting and JSON output](${markdownUrl("/docs/scripting")}): JSON contracts, command discovery, and confirmations.
- [Hooks](${markdownUrl("/docs/hooks")}): Commands that run after a saved change, with activity records on stdin.
- [Data and backups](${markdownUrl("/docs/data")}): Local storage, backups, restores, and database compatibility.
- [Core library](${markdownUrl("/docs/core")}): TypeScript setup, shared guarantees, and database compatibility.
- [Changelog](${markdownUrl("/changelog")}): Release changes, bundled core versions and breaking changes.

## Project information

${integrationLinks}
- [About Zinn](${markdownUrl("/about")}): Scope, Experimental status, source and license.
- [Contact](${markdownUrl("/contact")}): Public issue reporting and support information.
- [Privacy](${markdownUrl("/privacy")}): Website hosting and analytics, local CLI data and external links.
- [Pricing](${markdownUrl("/pricing")}): What Zinn costs in bytes, downloaded and on disk, and what a command costs to run.
- [Performance](${markdownUrl("/performance")}): Measured command times, memory, output and the path a command takes from an agent to SQLite and back.

## Optional

- [Source repository](${projectLinks.github}): Implementation, releases and issue tracker.
- [CLI package](${projectLinks.npm}): Published installation package.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
