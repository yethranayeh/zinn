# zinn

A kanban workflow in the terminal.

> [!IMPORTANT]
> **Experimental.** Commands, output, and the database schema will likely change often between releases until stable.
> Run `zinn backup` before upgrading. See [upgrading the database](#upgrading-the-database).

## Install

```sh
npm i -g @zinn-dev/cli
```

Requires [Node.js](https://nodejs.org/) 24.15.0 or newer. See [installation](https://zinn.sh/docs/installation) for upgrading, uninstalling and running on Bun.

## Quick start

Create a project, add a task, and move it through the board:

```sh
zinn project create MDR --name 'Macrodata Refinement'
zinn task create MDR --title 'Refine 75% of the numbers'
zinn task list MDR
zinn task move MDR-1 'In Progress'
zinn task view MDR-1
```

New projects start with Backlog, TODO, In Progress, Review, and Done columns. You can rename, reorder, and add columns.

Search tasks and comments, record a note, inspect recent activity, or archive completed work:

```sh
zinn task search numbers MDR
zinn task comment create MDR-1 --text 'Ready for review'
zinn activity list --task MDR-1
zinn task archive MDR-1
zinn task list MDR --archived
```

Use `zinn --help` to discover commands and `zinn <command> --help` for usage. Add `--json` for scripting. The [CLI README](packages/cli/README.md) covers filtering, labels, priorities, relations, text edits, and other command behavior.

## Coding agents

Choose either setup for your coding agent:

- **Skill:** install the [Zinn workflow skill](packages/cli/skills/zinn/SKILL.md) with `npx skills add yethranayeh/zinn --skill zinn -g -y`. It covers picking up work, keeping task context, recording follow-ups, and handing off for review.
- **Repository rule:** add a line to your `AGENTS.md` or `CLAUDE.md`, that should say something along the lines of “This repository uses Zinn for work tracking. Before substantial work, on resume, and before finishing, check the relevant task and keep it current. Use `zinn --help` to discover commands.”

See [agent setup and updates](https://zinn.sh/docs/installation#use-with-coding-agents) for details.

## Data location

Projects share the local database at `~/.zinn/data/zinn.sqlite`. Set `ZINN_DIR` to use another Zinn directory:

```sh
ZINN_DIR=./.zinn-local zinn project list
```

Use the same value on later commands to access that database. Relative paths are relative to the current folder. `ZINN_DIR` selects the database, backups, and settings together. The `settings.json` inside that directory supplies settings for the invocation.

Optional `zinn.local.json` and global `settings.json` files can choose the directory too. Precedence is `ZINN_DIR`, local settings, global settings, then `~/.zinn`. See [settings files](packages/cli/README.md#settings-files) for their format and path rules.

## Backups

`zinn backup` saves a complete database snapshot in the Zinn directory's `backups/` folder. `zinn restore <path>` restores the whole database, saving the current data first and asking for confirmation. See [restore the database](packages/cli/README.md#restore-the-database).

## Upgrading the database

Published releases _automatically_ upgrade older databases, saving a backup first. Source code builds _do not_ upgrade the default DB, only a separate database targeted with `ZINN_DIR`. You can also run `zinn migrate` explicitly. Upgrades apply completely or not at all. An already-current database is unchanged.

Newer databases open read-only. Databases without a schema version require `--allow-legacy-read` for read-only access and it is _not guaranteed_ that a legacy DB read will work as expected. See [upgrade the database](packages/cli/README.md#upgrade-the-database).

## Development

Zinn is developed with [Bun](https://bun.sh) 1.3, [pnpm](https://pnpm.io/) 10, [Node.js](https://nodejs.org/) 24 and Git. Other platforms, tools and versions are untested.

From the repository root, install dependencies and run the tests:

```sh
bun install
bun test packages scripts
bun run test:node
```

The tests also pack and run the built packages, so they need pnpm, Node.js and Git on `PATH`. `bun run test:node` runs core's SQLite checks under Node.js. The website has its own tests; see [docs](docs/README.md).

### Development data

Seed and use the isolated `.zinn-dev` database:

```sh
bun run dev:seed
bun run dev -- task list
```

The seed includes projects, labels, relations, and archived tasks. `dev:seed` **deletes and recreates** only that development database and its SQLite sidecar files. `dev` always uses `.zinn-dev`. Please note that ordinary `zinn` commands use your configured database.

To run the development CLI from another folder:

```sh
bun /path/to/zinn/scripts/dev-cli.ts task list
```

## Packages

| Package                           | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| [`@zinn-dev/cli`](packages/cli)   | The `zinn` command-line interface        |
| [`@zinn-dev/tui`](packages/tui)   | Terminal interface stub, not prioritized |
| [`@zinn-dev/core`](packages/core) | Shared logic and storage                 |

## License

MIT
