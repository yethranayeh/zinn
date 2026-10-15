import type { APIRoute } from "astro";
import { projectLinks } from "../config/site";

export const GET: APIRoute = () =>
  new Response(
    `# Zinn

> Zinn is an Experimental kanban CLI and task manager for the terminal. It stores projects and tasks in a local SQLite database and requires Node.js 24.15.0 or newer.

When to use Zinn: track development work locally, carry task scope and progress between sessions, or read and update a project's board from scripts and agents using the CLI's JSON output. Run Zinn on the user's machine with shell access; start with \`zinn --help\` and read the CLI reference before changing tasks.

## When to use

- [CLI workflow](https://raw.githubusercontent.com/yethranayeh/zinn/main/packages/cli/README.md): Track local development work with projects, tasks and progress comments; read and update a board with JSON output. Start with \`zinn --help\` and inspect each command's help before calling it.

## Documentation

- [Zinn overview](https://zinn.sh/index.md): Product, installation, project workflow and local storage.
- [Installation](https://zinn.sh/docs/installation.md): Requirements, installing, upgrading and uninstalling the CLI and core, and running them on Bun.
- [CLI reference](https://raw.githubusercontent.com/yethranayeh/zinn/main/packages/cli/README.md): Commands, flags, confirmations, JSON contracts and database configuration.
- [Core library](https://raw.githubusercontent.com/yethranayeh/zinn/main/packages/core/README.md): TypeScript library installation and operations.

## Project information

- [About Zinn](https://zinn.sh/about.md): Scope, Experimental status, source and license.
- [Contact](https://zinn.sh/contact.md): Public issue reporting and support information.
- [Privacy](https://zinn.sh/privacy.md): Website hosting and analytics, local CLI data and external links.

## Optional

- [Source repository](${projectLinks.github}): Implementation, releases and issue tracker.
- [CLI package](${projectLinks.npm}): Published installation package.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
