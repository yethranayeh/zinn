# zinn

A kanban workflow in the terminal.

> [!IMPORTANT]
> **Experimental.** Commands, output and the database schema _can_ and **will** change between releases.
> A newer Zinn upgrades an older database. Read ([how](#upgrading-the-database)).
> Run `zinn backup` before upgrading.

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
zinn task list MDR --label CLI --label Groom
zinn project view MDR
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

Edits change only supplied fields. Valid edits that leave values unchanged succeed without changing modification timestamps or recording activity. See the [editing conventions](packages/cli/README.md#editing-conventions) for shared rules, description clearing, and naming requirements.

## Task search

Search task titles, descriptions, and comments with `zinn task search <query> [<project-key>]`:

```sh
zinn task search "quarterly quota" MDR
```

Words match the start of words, ignoring case and accents, and every word must match. To surface matches from archived tasks, you can pass `--archived` or `--all`. See the [CLI documentation](packages/cli/README.md#search-tasks) for ranking, `--limit`, and task key lookups.

## Task relations

To establish any kind of relationship between two tasks, the general syntax is: `zinn task relation create <source-task> <target-task> --type <relation-type>`

For example, you can use `zinn task relation create MDR-1 MDR-2 --type dependency` to indicate that MDR-1 _depends on_ MDR-2. Other available relation types are:

- `duplicate`: first task is a duplicate of the second,
- `related`: mentioned cases are related to each other (first/second order does not matter)

To see created relations, you can use `zinn task relation list MDR-1` and for task-specific relation details you can use `zinn task view MDR-1`.

Use `zinn task relation create APP-2 APP-1 --type subtask` to make APP-2 a child of APP-1. Each task can have at most one parent and any number of subtasks. A nested type of relationship is allowed, so a task can have both a parent and a child.

Parents are also just ordinary tasks, including tasks in other projects or archived tasks. Relation list and task view show **Parent** on the child and **Subtask** on the parent. Remove the existing subtask relation before assigning a different parent. Moving or archiving a parent does not change its children, and deleting a parent removes its child relations while retaining child task data.

Remove a relation with `zinn task relation delete MDR-1 MDR-2 --type dependency`, using its original direction for `dependency`, `duplicate`, and `subtask`. For `related`, order does not matter.
Note that a deletion happens _without_ confirmation.

See the [CLI documentation](packages/cli/README.md#task-relations) for details.

## Task comments

Comments can be written to tasks for additional information. Comments are assigned keys on creation which can be used to target them for further operations:

```sh
zinn task comment create MDR-1 --text "Ready for review"
zinn task comment list MDR-1
zinn task comment edit MDR-1#1 --text "Approved"
zinn task comment delete MDR-1#1
```

Comments also appear in `task view`. See the [CLI documentation](packages/cli/README.md#task-comments) for details.

## Data location

Zinn stores its shared local database at `~/.zinn/data/zinn.sqlite`. Every Zinn project on your machine uses that database unless `ZINN_DIR` or a settings file points elsewhere.

Set `ZINN_DIR` to use another Zinn folder, with the same layout as `~/.zinn`. For example:

```sh
mkdir -p "./.zinn-local"
ZINN_DIR="./.zinn-local" zinn project list
```

Use the same `ZINN_DIR` value on later commands to access that database. A relative `ZINN_DIR` stays relative to the current folder.

### Settings files

A settings file can choose the Zinn folder without `ZINN_DIR`:

- `~/.zinn/settings.json` is the global file. When `ZINN_DIR` is set, it is `settings.json` in that folder.
- `zinn.local.json` is the per-codebase file. Zinn uses the nearest one, from the current folder up to the Git root, or only the current folder outside a Git repository.

`zinn.local.json` is personal: it holds paths from one machine, so it is not meant to be committed. Zinn reads it whether or not git ignores it. It is merged over the global file, field by field. A missing file is fine, and Zinn creates no settings file.

Both are plain JSON, without comments:

```json
{
	"storage": {
		"directory": "~/work/zinn-data"
	}
}
```

`storage.directory` names a Zinn folder, with `data/zinn.sqlite` and `backups/` inside. The first of these that is set decides where the database is: `ZINN_DIR`, `storage.directory` in `zinn.local.json`, `storage.directory` in the global `settings.json`, then `~/.zinn`. A relative `storage.directory` is relative to the folder of the file that sets it, and a leading `~` or `~/` means your home folder. The file may also carry a `$schema` string, which Zinn ignores.

An unknown key, a value of the wrong type or invalid JSON stops every command with an error that names the file. See the [CLI documentation](packages/cli/README.md#settings-files).

## Backups

Run `zinn backup` to save a copy of the database to the `backups/` folder next to `data/`, in a file named after the UTC time and the CLI version that made it. It is recommended that you make a backup before upgrading Zinn, you know, just in case.

Run `zinn restore <path>` to put back the board from a backup file. It saves the current board as a backup first, and asks for confirmation unless `--yes` is used. See [Restore the database](packages/cli/README.md#restore-the-database) in the CLI README.

## Upgrading the database

The database records a schema version, and a newer Zinn upgrades an older database to its own version. The upgrade is applied completely or not at all, after a backup is saved. A published release does it by itself the first time it opens the database. When Zinn refuses a change because the database is older, as a source checkout does for any database except one chosen by `ZINN_DIR`, or when you want to upgrade right after installing a newer Zinn, run `zinn migrate`. It prints the backup it saved and the versions before and after, or does nothing when the database is already up to date. If the upgrade fails, the database is unchanged and the backups stay in the backups folder.

A database that has no schema version is refused unless the command carries `--allow-legacy-read`, which tries to read it as much as it can, without changing anything in there. See [Upgrade the database](packages/cli/README.md#upgrade-the-database) in the CLI README.

## Development data

For local development you can seed the repository `.zinn-dev` database with mock data:

```bash
bun run dev:seed
bun run dev -- task list
```

The sample board includes three projects, shared labels, tasks in different workflow columns, custom ordering, multiline descriptions, archived work, and all four relation types. Start with `bun run dev -- task view APP-3` to inspect a connected task, or `bun run dev -- task view APP-8` to see a subtask hierarchy. Run `bun run dev -- label list` to browse labels. Move, edit, reorder, and restore tasks freely to test things out. You can also run the seed again to reset the examples.

`dev:seed` deliberately **deletes** and recreates the repository development database and its SQLite sidecar files. The `dev` command always uses that same ignored directory. Its script can also be run by absolute path from outside the repository while preserving CLI arguments:

```bash
bun /path/to/zinn/scripts/dev-cli.ts task list
```

The usual `zinn` commands continue to use the database that `ZINN_DIR` or your settings files choose, or `~/.zinn`.

## Packages

| Package                           |                                           |
| --------------------------------- | ----------------------------------------- |
| [`@zinn-dev/cli`](packages/cli)   | the `zinn` terminal binary                |
| [`@zinn-dev/tui`](packages/tui)   | the WIP terminal interface                |
| [`@zinn-dev/core`](packages/core) | shared logic the other packages call into |

## License

MIT
