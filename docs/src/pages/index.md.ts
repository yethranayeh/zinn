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

Zinn is an Experimental task manager for you and the agents you work with.

Each project is a board of columns and tasks. You and your agents create, move and comment on the same tasks with the same commands, and all of it lives in one SQLite database on your machine.

## Start a project. Move the work.

Create a project, add a task, then move it into In Progress. Each project begins with Backlog, TODO, In Progress, Review and Done columns, which you can rename or extend.

Descriptions hold the scope and comments the updates. Labels and priorities organize the work, and related, dependency, duplicate and subtask relations connect it. Search covers titles, descriptions and comments, and archiving hides finished tasks from active lists.

\`\`\`sh
zinn project create DEMO --name 'Release work'
zinn task create DEMO --title 'Write release notes' --priority high
zinn task move DEMO-1 'In Progress'
zinn task list DEMO --json
\`\`\`

Give a task a deadline with \`--due\`, then sort by it with \`task list --sort due\` or select a range with \`--due-since\` and \`--due-until\`. \`task move\`, \`task archive\` and \`task delete\` take several tasks at once. \`--description-file\` and \`--text-file\` read text from a file or stdin, and \`--limit\` with \`--starting-after\` continues a long list.

## Work alongside your agents

Zinn doesn't stop at who changed a task. It takes you back into the conversation that made the change.

[Activity](https://zinn.sh/docs/cli#activity) records the agent and session behind a change, and \`zinn activity list --task <task-key>\` lists the changes to a task. Claude Code and Codex sessions are recorded without setup.

The Zinn workflow skill teaches an agent to find its task, keep context in comments, record follow-ups and hand off at the project's review column. [Set it up for your agent](https://zinn.sh/docs/installation#use-with-coding-agents).

For scripts, \`--json\` prints one JSON document on stdout. A failure exits with code 1 and writes a JSON error to stderr, with a code scripts can match. \`zinn capabilities --json\` describes every command's inputs, effects and result schemas, and \`--yes\` confirms prompts. Read [scripting and JSON output](https://zinn.sh/docs/scripting) for the details.

## Keep the work local

Every project lives in one SQLite database, \`~/.zinn/data/zinn.sqlite\` by default. Keep it elsewhere with [settings](https://zinn.sh/docs/settings).

\`zinn backup\` saves a database snapshot, and \`zinn restore\` puts one back after saving the current database. A newer release upgrades an older database the first time it opens it, saving a backup first. Read [data and backups](https://zinn.sh/docs/data) for the details.

## Take the next command

Zinn is free and MIT licensed. See its [price in bytes and running costs](https://zinn.sh/pricing).

Read the [quick start](https://zinn.sh/docs/quick-start) or [project reference](https://zinn.sh/docs/cli#start-a-project), browse the [Zinn source on GitHub](${projectLinks.github}) or find the [Zinn CLI package on npm](${projectLinks.npm}).

Read [About Zinn](https://zinn.sh/about), [Contact](https://zinn.sh/contact) and [Privacy](https://zinn.sh/privacy).

[Twitter](${projectLinks.twitter}) · [Bluesky](${projectLinks.bluesky})
`;
  return new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
