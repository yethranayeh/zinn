---
layout: ../layouts/InfoLayout.astro
title: About Zinn | Experimental kanban CLI
description: Learn what Zinn does, how its local kanban workflow fits terminal work, and where to find its source, license and documentation.
---

# About Zinn

Zinn is an Experimental kanban CLI and task manager for the terminal. It brings projects, columns and tasks into the command line, and uses a local SQLite database to hold all the work. With this setup, developers and agents can keep task scope, priorities, labels and comments close to the commands they already run.

## A local workflow

Each project has its own board. Tasks move between its columns as work progresses, and related, dependency, duplicate and subtask relations connect the work. Descriptions hold scope, while comments record updates. Search helps find tasks by their titles, descriptions and comments, and archiving keeps completed work available outside the active list.

Scripts and agents can use the same CLI with JSON output. Read the [CLI reference](https://github.com/yethranayeh/zinn/blob/main/packages/cli/README.md) for commands and example calls.

## Source and status

Zinn's [source repository](https://github.com/yethranayeh/zinn) is public and the software is [MIT licensed](https://github.com/yethranayeh/zinn/blob/main/LICENSE).

The published CLI is [@zinn-dev/cli](https://www.npmjs.com/package/@zinn-dev/cli) on npm.

Since Zinn is in early experimental stages, consult the documentation for the version you install and keep backups of work you want to preserve.

Read [Contact](/contact) for reporting problems and [Privacy](/privacy) for website analytics and local data information.
