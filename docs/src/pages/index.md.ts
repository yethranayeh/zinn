import type { APIRoute } from "astro";
import { homepage, installCommand, projectLinks } from "../config/site";

export const GET: APIRoute = () => {
  const markdown = `# Zinn

A kanban workflow in the terminal.

${homepage.description}

## Install

\`\`\`sh
${installCommand}
zinn --help
\`\`\`

Read the [installation guide](https://zinn.sh/docs/installation) for requirements, upgrading and uninstalling.

## Zinn: a kanban CLI for your terminal

Zinn is an Experimental kanban task manager for the terminal.

Organize work into projects, columns and tasks. Manage it from the command line, with descriptions, priorities, labels and comments to keep the detail close. Projects and tasks are stored in a local SQLite database.

For developers who already work in the terminal, the board is another command away. Scripts and agents can read and write tasks using the CLI's JSON output.

## Start a project. Move the work.

Create a project, add a task, then move it into In Progress. Each project begins with Backlog, TODO, In Progress, Review and Done columns, which you can rename or extend.

Use descriptions for scope, comments for updates and labels and priorities to organize tasks. Connect work with related, dependency, duplicate and subtask relations. Search titles, descriptions and comments, and archive tasks when they no longer belong in the active list.

\`\`\`sh
zinn project create DEMO --name 'Release work'
zinn task create DEMO --title 'Write release notes' --priority high
zinn task move DEMO-1 'In Progress'
zinn task list DEMO --json
\`\`\`

Add \`--json\` to any command for a single JSON document on stdout. Empty lists return \`[]\`; errors go to stderr as JSON with exit code 1. Use \`--yes\` to skip confirmation prompts in scripts and agent workflows.

## Keep the work local

The default database is \`~/.zinn/data/zinn.sqlite\`. Set \`storage.directory\` in a codebase's \`zinn.local.json\` or in \`~/.zinn/settings.json\` to keep it elsewhere. \`ZINN_DIR\` overrides both for the commands that carry it.

\`zinn backup\` saves a database snapshot, and \`zinn restore\` puts one back after saving the current database. A newer Zinn upgrades an older database, and \`zinn migrate\` runs that upgrade after saving a backup.

Read the [settings files](${projectLinks.github}/blob/main/packages/cli/README.md#settings-files), [database backup](${projectLinks.github}/blob/main/packages/cli/README.md#back-up-the-database), [database restore](${projectLinks.github}/blob/main/packages/cli/README.md#restore-the-database) and [database upgrade](${projectLinks.github}/blob/main/packages/cli/README.md#upgrade-the-database) instructions.

## Take the next command

Read the [first-project guide](${projectLinks.github}/blob/main/packages/cli/README.md#start-a-project), browse the [Zinn source on GitHub](${projectLinks.github}) or find the [Zinn CLI package on npm](${projectLinks.npm}).

Read [About Zinn](https://zinn.sh/about), [Contact](https://zinn.sh/contact) and [Privacy](https://zinn.sh/privacy).

[Twitter](${projectLinks.twitter}) · [Bluesky](${projectLinks.bluesky})
`;
  return new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
