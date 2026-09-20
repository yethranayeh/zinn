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
zinn project create MDR --name "Macrodata Refinement"
zinn task create MDR --title "Refine 75% of the numbers" --description "Qualify for a Music Experience"
zinn task list MDR
zinn task view MDR-1
```

A new project starts with Backlog, TODO, In Progress, Review, and Done columns.
Move work through those columns and archive it when it no longer belongs in the active list:

```sh
zinn task move MDR-1 "In Progress"
zinn task archive MDR-1
zinn task list MDR --archived
```

Run `zinn --help` to see every command, `zinn task --help` to browse task commands, or `zinn <command> --help` for command-specific usage. The complete command reference is in the [CLI README](packages/cli/README.md).

Running `zinn` without a command shows help.

## Task relations

To establish any kind of relationship between two tasks, the general syntax is: `zinn task relation create <source-task> <target-task> --type <relation-type>`

For example, you can use `zinn task relation create MDR-1 MDR-2 --type dependency` to indicate that MDR-1 _depends on_ MDR-2. Other available relation types are:

- `duplicate`: first task is a duplicate of the second,
- `related`: mentioned cases are related to each other (first/second order does not matter)

To see created relations, you can use `zinn task relation list MDR-1` and for task-specific relation details you can use `zinn task view MDR-1`.

Remove a relation with `zinn task relation delete MDR-1 MDR-2 --type dependency`, using its original direction for `dependency` and `duplicate`. For `related`, order does not matter.
Note that a deletion happens _without_ confirmation.

See the [CLI documentation](packages/cli/README.md#task-relations) for details.

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
