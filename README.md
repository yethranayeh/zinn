# zinn

A kanban workflow in the terminal.

## Install

```bash
bun add -g @zinn-dev/cli
```

Requires [Bun](https://bun.sh).

## Quick start

Create a project, add a task, and inspect it:

```sh
zinn project create "Side project" SIDE
zinn task create SIDE "Ship the first version" "Finish the README and publish it"
zinn task list SIDE
zinn task view SIDE-1
```

A new project starts with Backlog, TODO, In Progress, Review, and Done columns.
Move work through those columns and archive it when it no longer belongs in the
active list:

```sh
zinn task move SIDE-1 "In Progress"
zinn task archive SIDE-1
zinn task list SIDE --archived
```

Run `zinn --help` to see every command, `zinn task --help` to browse task commands, or `zinn <command> --help` for command-specific usage. The complete command reference is in the [CLI README](packages/cli/README.md).

Running `zinn` without a command launches the terminal interface when attached to an interactive terminal. The TUI is still a work in progress. So, use the CLI commands for the complete current workflow.

## Data location

Zinn stores its shared local database at `~/.zinn/data/zinn.sqlite`. Every Zinn project on your machine uses that database by default, regardless of the current working directory.

Set `ZINN_DIR` to keep the settings and database under another existing parent directory. For example:

```sh
mkdir -p "./.zinn-local"
ZINN_DIR="./.zinn-local" zinn project list
```

Use the same `ZINN_DIR` value on later commands to access that database.

## Development data

For local development, it is possible to populate the default database with mock data:

```bash
bun run dev:seed
```

Please note that this development command ignores `ZINN_DIR`, deletes the database and SQLite sidecar files at `~/.zinn/data/zinn.sqlite`, and recreates the database. **DO NOT** run it if you have existing data in the default Zinn DB path that you would want to preserve.

## Packages

| Package                           |                                           |
| --------------------------------- | ----------------------------------------- |
| [`@zinn-dev/cli`](packages/cli)   | the `zinn` terminal binary                |
| [`@zinn-dev/tui`](packages/tui)   | the WIP terminal interface                |
| [`@zinn-dev/core`](packages/core) | shared logic the other packages call into |

## License

MIT
