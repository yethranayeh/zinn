# @zinn-dev/cli

The `zinn` command-line interface. Requires [Bun](https://bun.sh).

> [!IMPORTANT]
> **Experimental.** Commands, output and the database schema _can_ and **will** change between releases.
> A newer Zinn upgrades an older database. Read ([how](#upgrade-the-database)).
> Run `zinn backup` before upgrading.

## Install

```sh
bun add --global @zinn-dev/cli
```

Zinn stores projects and tasks in the shared local database at `~/.zinn/data/zinn.sqlite`.
Set `ZINN_DIR` to use another Zinn directory and keep using the same value for commands that should share that database.

## Editing conventions

Edit commands change only the fields you supply; omitted fields keep their current values. At least one edit field is required. After input normalization, a valid edit that leaves all values unchanged succeeds without writing changes, updating modification timestamps, or recording activity.

Move, order, archive, unarchive, and task-label attachment commands also succeed without changes when the requested state is already satisfied. This does not apply to creation: creating an existing relation, for example, is an error.

Project and column names cannot be blank or contain line breaks or control characters, such as tabs. Column names are trimmed; project names retain surrounding spaces. Label names are trimmed and cannot be blank; task titles cannot be blank. Labels and task titles do not currently enforce the project/column single-line rule.

Project, task, and label descriptions may contain multiple lines. Omitted descriptions on creation, empty strings, and whitespace-only strings are stored as `null`. Text containing a non-whitespace character is preserved exactly, including leading and trailing whitespace. Use `--description ""` on an edit to clear a description. JSON returns the full text or `null`.

## Changing tasks in bulk

`task move`, `task archive` and `task unarchive` accept multiple task keys, so several tasks can be changed in one command:

- Tasks are changed in the order given.
- If any task fails, for example because of an unknown key, none change.
- A task already in the requested state is listed as usual, with a note on stderr, such as `MDR-1 was already archived`. This includes a key given twice: by its second occurrence, the task is already in the requested state.
- With `--json`, one task prints an object and several print an array. Each task has a `changed` field, which is `false` when the task was already in the requested state.

## Concurrent access

Commands on the same machine can share a database on a local filesystem. Zinn waits up to 30 seconds each time the database is locked by another command. If the lock is still held after that wait, the command _fails_. The command's total running time can exceed 30 seconds. Zinn also briefly retries specific initialization races internally. Initialization errors include the underlying message and code.

## Start a project

Create a project with a key and optionally provide a name and description:

```sh
zinn project create MDR --name "Macrodata Refinement" --description "Refine macrodata"
```

Project keys are stored in **uppercase**. You can create a project without a project name, like `zinn project create MDR`, which will just default to having the key as the project name too.

Project list and mutation text show truncated inline description previews, while `project view` prints the description in full. See [Editing conventions](#editing-conventions) for description storage and clearing.

Each project starts with _Backlog_, _TODO_, _In Progress_, _Review_, and _Done_ columns.

You can list projects or inspect a project's columns with:

```sh
zinn project list
zinn project view MDR
zinn project column list MDR
```

`project view` prints the project with its full description and the number of unarchived tasks in each column. Archived tasks are counted as one total. Use `zinn task list <project-key>` to list the tasks themselves.

Edit a project:

```sh
zinn project edit MDR --name "Macrodata Refinement (Morning Shift)"
zinn project edit MDR --description "Meet the quarterly quota"
zinn project edit MDR --description ""
```

Provide `--name`, `--description`, or both.
Use `--name="--example"` when a value begins with a dash.

Add another column at the end of the board:

```sh
zinn project column create MDR "Boardlog"
```

Rename a column:

```sh
zinn project column edit MDR "In Progress" --name "Refining"
```

Columns are matched by name, and matching is case-insenstivie. Names are trimmed and they cannot be blank.
Since columns are case-insensitive, you cannot have two columns with only different casing such as `todo` and `Todo`. However, you are free to change the casing of an existing column.
Tasks stay in the renamed column.

Change a column's position on the board:

```sh
zinn project column order MDR Review first
zinn project column order MDR Review previous
zinn project column order MDR Review next
zinn project column order MDR Review last
zinn project column order MDR Review before "In Progress"
zinn project column order MDR Review after Done
```

Directions follow board order: `first` is the start of the board and `last` is its end.
Both the column and the target of `before` or `after` are matched by name, and matching is case-insensitive.
Moving a column to the position it already has, or before or after itself, does nothing. Tasks stay in their columns.

`zinn project delete MDR` asks for confirmation, then permanently deletes the project and all of its columns and tasks. `--yes` skips the confirmation (see [Confirmations](#confirmations)).

## Create and read tasks

Create a task with a title and an optional description. New tasks enter the project's first column:

```sh
zinn task create MDR --title "Refine 75% of the numbers"
zinn task create MDR --title "Review the employee handbook" --description "Prepare for a 75% Dance Experience"
```

Tasks are created with keys such as `MDR-1`. List active tasks, optionally limited to one project, or view one task:

```sh
zinn task list
zinn task list MDR
zinn task list MDR --label CLI --label Groom
zinn task view MDR-1
```

The list follows the project's column order and the task order within each column. Without a project key, projects are listed one after another, sorted by key.

Each row shows the task's key, column, priority marker, title, and labels, such as `MDR-1 | TODO | H | Refine the numbers | bug, cli`. Preview lists _do not_ contain the descriptions. To see everything, `task view` should be used.

`task view` prints the description in full, keeping its line breaks.

Use `--label <name>` to list tasks with a label. You can provide multiple `--label` flags to refine your filter further down to more specific task results. Label names matching ignores casing. An unknown label causes an error to be raised.

## Search tasks

Search task titles, descriptions, and comments, optionally in one project:

```sh
zinn task search refine
zinn task search "quarterly quota" MDR
zinn task search MDR-1
zinn task search auth --all --limit 5
zinn task search auth MDR --label cli
```

Each query matches the start of a word, ignoring case and accents, so `cafe` finds "Café" and `auth` finds "Authentication". Every word must match somewhere in the task: its title, its description, or any of its comments. A comment match lists the task the comment belongs to.

If the whole query is an existing task key, such as `mdr-1`, that task comes first. Other results follow by relevance, with title matches weighted highest. Equally relevant tasks are ordered by project key, then task number.

Note that by default only the active tasks are searched.
`--archived` searches only archived tasks and `--all` searches both, just like how it is with `task list`. When archived matches are left out, Zinn prints a note such as `2 archived matches hidden, use --all to include them`. This extra info is not a part of the `--json` output. `--limit <n>` shows at most `n` results.

`--label` works as it does for `task list`: repeat it to require every specified label. Label filtering happens before `--limit` and before archived matches are counted.

Results use the same rows and `--json` shape as `task list`. A search with no results prints nothing and exits successfully. Put `--` before a query that begins with a dash: `zinn task search -- -flag`.

Search uses an index that Zinn keeps up to date as tasks and comments change. `zinn reindex` rebuilds it from the tasks and their comments, archived tasks included:

```sh
zinn reindex
```

Only the index changes, completely or not at all, so no backup is saved. With `--json`, it prints `{ "databasePath": "...", "taskCount": 12 }`. The command fails without changing anything when there is no database yet, or when Zinn refuses changes to the database, such as one with a newer schema version (see [Upgrade the database](#upgrade-the-database)).

## Labels

Labels are global and reusable in all the available projects.

```sh
zinn label create urgent --color red --description "Needs attention soon"
zinn label create review
zinn label edit review --name ready --color green
zinn label list
```

### Adding to tasks

```sh
zinn task create MDR --title "Check the numbers" --label urgent --label review
zinn task label add MDR-1 urgent review
zinn task label remove MDR-1 review
zinn task edit MDR-1 --add-label review --remove-label urgent
```

For adding or removing multiple labels at the same time, repeat `--label` on creation, or `--add-label` and `--remove-label` while editing for each label.
Each value is considered as the label name: `--label "needs review"`, so if you have commas, then they are considered parts of names.
Label names preserve their stored casing, but matching and uniqueness are case-insensitive. For example, `BUG` can match to a label stored as `Bug`, `Bug` or `bug`, but all three canno exist at the same time as three different label entries. Changing only the casing of an existing label is allowed. Whitespace around label names is trimmed.

Label colors default to white. Available colors are _red_, _green_, _yellow_, _blue_, _magenta_, _cyan_, _white_, and _gray_.

`label create`, `label edit` and `label list` print each label name in its color. When color is off (see [Scripting and JSON output](#scripting-and-json-output)), they name the color instead, such as `bug | red | Broken`. `--json` output always shows the color as a value.

`label edit` accepts name, color, and description. Renaming preserves every task attachment because attachments refer to the label's internal ID. Updating a label definition does not affect attached tasks' timestamps.

Task creation and edits apply content and label changes together, or roll back together on failure.
Changing a task's label attachments updates that task's modification timestamp. Archived tasks can also have their labels edited.

Commands like `task list`, `task view` and task mutation output show attached labels, printing each label name in its color (see [Scripting and JSON output](#scripting-and-json-output) for when color appears). `--json` output lists a task's labels as names.

`zinn label delete urgent` asks for confirmation, then deletes the definition and removes it from every task. Declining confirmation leaves the label and its attachments unchanged. `--yes` skips the confirmation (see [Confirmations](#confirmations)).
Use `task label remove` to remove a label attachment from one task instead. Task/project deletion cleans up label attachments, but does not affect labels themselves.

## Task relations

```sh
zinn task relation create MDR-1 MDR-2 --type dependency
zinn task relation create MDR-1 MDR-2 --type duplicate
zinn task relation create MDR-1 OTHER-1 --type related
zinn task relation list MDR-1
```

`dependency` means the first task depends on the second, `duplicate` means the first task is a duplicate of the second. `related` is a bit different as the order of the tasks mentioned _does not matter_, either case describes the same relation.

Relations do not automatically move, complete, or archive tasks.
Tasks from separate projects can be related to each other. Tasks can also be related to archived tasks.

`task view` a task's existing relations.

Use `zinn task relation create APP-2 APP-1 --type subtask` to make APP-2 a child of APP-1. Each task can have at most one parent and any number of subtasks. A nested type of relationship is allowed, so a task can have both a parent and a child. Parents are also just ordinary tasks, including tasks in other projects or archived tasks. Relation list and task view show **Parent** on the child and **Subtask** on the parent.

Remove the existing subtask relation before assigning a different parent. Moving or archiving a parent does not change its children, and deleting a parent removes its child relations while retaining child task data.

Remove a relation with `zinn task relation delete MDR-1 MDR-2 --type dependency`, using its original direction for `dependency`, `duplicate`, and `subtask`. For `related`, order does not matter.
Note that a deletion happens _without_ confirmation.

Use `task relation create --help` to discover types.

## Task comments

Add and list comments on a task:

```sh
zinn task comment create MDR-1 --text "Ready for review"
zinn task comment list MDR-1
```

Comments receive keys per task like `MDR-1#1`.
Comment lists show each comment's creation time in local time as `YYYY-MM-DD HH:mm ±HH:mm`.
`task view` includes the task's comments in the same format.

Edit or delete a comment using its key:

```sh
zinn task comment edit MDR-1#1 --text "Approved"
zinn task comment delete MDR-1#1
```

Deletion asks for confirmation, unless `--yes` is used (see [Confirmations](#confirmations)). Comments can be added to archived tasks. Comment mutations are recorded in the activity log without changing the task's modification timestamp.

## Edit tasks

Edit a task's title, description, priority, or labels:

```sh
zinn task edit MDR-1 --title "Meet the quarterly refinement quota"
zinn task edit MDR-1 --description "Complete refinement before the waffle party"
zinn task edit MDR-1 --title "Meet the quarterly refinement quota" --description ""
```

See [Editing conventions](#editing-conventions) for partial edits and clearing descriptions.

Archived tasks can be edited without unarchiving them.
Use `--title="--example"` when a value begins with a dash.

## Move and order tasks

Move a task to another column in its project:

```sh
zinn task move MDR-1 "In Progress"
```

A moved task appears at the bottom of its destination column. Moving it to its current column does nothing. Archived tasks must be unarchived before they can be moved.

Move multiple tasks at once by giving their keys before the column. They land at the bottom of the column in the order given, unless of course a task was _already_ in that column, in which case they stay as they were. Tasks from different projects can be moved together, and each one's column is looked up in its own project:

```sh
zinn task move MDR-1 MDR-2 APP-4 "In Progress"
```

See [Changing tasks in bulk](#changing-tasks-in-bulk).

Change a task's position within its current column:

```sh
zinn task order MDR-2 top
zinn task order MDR-2 up
zinn task order MDR-2 down
zinn task order MDR-2 bottom
zinn task move MDR-2 "In Progress"
zinn task order MDR-2 before MDR-1
zinn task order MDR-2 after MDR-1
```

The task being reordered and the target of `before` or `after` must be active tasks in the same column.

## Archive and delete tasks

Active tasks are shown by default. Archive one or more tasks to hide them from active lists, then list archived tasks or all tasks:

```sh
zinn task archive MDR-1
zinn task archive MDR-2 MDR-3
zinn task list MDR --archived
zinn task list MDR --all
```

`--archived` and `--all` cannot be used together. In an `--all` listing, Zinn adds an Active or Archived status column.

Unarchiving puts a task at the bottom of its previous column:

```sh
zinn task unarchive MDR-1
zinn task unarchive MDR-2 MDR-3
```

Archive or unarchive multiple tasks by giving several keys. Unarchived tasks land in the order given. See [Changing tasks in bulk](#changing-tasks-in-bulk).

Delete a task permanently with `zinn task delete MDR-1`. It asks for confirmation before performing the action, unless `--yes` is used (see [Confirmations](#confirmations)).

## Back up the database

It is recommended to save a copy of the database before installing a new version:

```sh
zinn backup
```

The copy goes to `~/.zinn/backups/` (or `backups/` in `ZINN_DIR`), in a file named after the UTC time and the CLI version that made it, with an eight-character random suffix to distinguish backups made at the same time, like `2026-09-29T12-30-05Z-cli-0.32.0-b38178c0.sqlite`. It is a single file with every change made so far, and it is safe to take while Zinn is in use. Existing backups are never overwritten. With `--json`, the command prints `{ "path": "..." }`. It fails when there is no database yet.

## Restore the database

Put back the board from a backup file, such as one saved by `zinn backup` or by an upgrade:

```sh
zinn restore ~/.zinn/backups/2026-09-29T12-30-05Z-cli-0.32.0-b38178c0.sqlite
```

The command asks for confirmation, unless `--yes` is used (see [Confirmations](#confirmations)). It saves the current board as a backup first, in the same folder as `zinn backup`, then replaces the board with the backup's, completely or not at all. Restoring onto a missing database creates it. With `--json`, it prints `{ "databasePath": "...", "previousVersion": 1, "restoredVersion": 1, "backupPath": "..." }`, where `backupPath` is the saved copy of the replaced board, or `null` when there was no board to save.

A backup with an older schema version is restored at that version, and Zinn then upgrades it like any older database (see [Upgrade the database](#upgrade-the-database)). The restore works whatever the version of the database it replaces, so you can go back to an older Zinn and restore the backup an upgrade saved.

The command fails without changing anything when the backup has a newer schema version than your Zinn (the error names the Zinn version that made the backup if its file name carries one), when it has no schema version, when it is **damaged**, or when it is not a Zinn database. If the restore fails after that, the database is unchanged, and any backup saved before the attempt stays in `~/.zinn/backups/` (or `backups/` in `ZINN_DIR`).

If the database being replaced is damaged, restore leaves it unchanged and prints recovery steps.

## Upgrade the database

The database records a schema version, and a newer Zinn upgrades an older database to its own version. The upgrade is applied completely or not at all, and a backup is saved first, in the same folder as `zinn backup`.

A published release of Zinn upgrades the database by itself the first time it opens it. Run `zinn migrate` to upgrade it yourself, for example right after installing a newer Zinn, or when Zinn refuses a change because the database is older. A build run from a source checkout refuses changes to the default database, `~/.zinn`, until you do:

```sh
zinn migrate
```

The command saves a backup, upgrades the database and reports the backup's path with the schema versions before and after. When the database is already up to date, it changes nothing and saves no backup. With `--json`, it prints `{ "databasePath": "...", "previousVersion": 1, "finalVersion": 2, "changed": true, "backupPath": "..." }`, where `backupPath` is `null` when nothing changed.

If the upgrade fails, the database is unchanged. The backups taken before each attempt stay in `~/.zinn/backups/` (or `backups/` in `ZINN_DIR`). The command fails without attempting anything when there is no database with data yet, when the database has no schema version, or when it is newer than your Zinn.

A database with a newer schema version than your Zinn can be read, but changes are refused. Use a newer Zinn to change it.

### Databases without a schema version

A database created before Zinn recorded schema versions has none. Zinn refuses to open it, and `zinn migrate` does not upgrade it. Add `--allow-legacy-read` to a command to read it anyway:

```sh
zinn task list MDR --allow-legacy-read
```

Reads are best effort and may fail or omit data, and Zinn warns about it on stderr once per command. The flag never lets a command change the database, and it applies only to the command that carries it. Like `--json`, it can go anywhere in the command, except after `--`, where it is treated as a regular argument. `zinn backup` works on such a database without the flag.

## Scripting and JSON output

Add `--json` to any command to get JSON instead of text. The flag can go anywhere in the command, except after `--`, where it is treated as a regular argument such as searching literally for `--json` in text.

```sh
zinn task list MDR --json
zinn task create MDR --title "Refine the numbers" --json
```

- Read commands print what they list or show. Write commands print the entity they created, changed, or deleted.
- Output is a single JSON document on stdout. Empty lists print `[]`.
- Errors go to stderr as `{ "error": { "message": "..." } }`, stdout stays empty, and the command exits with code 1.

Text output is mainly for _visual_ consumption. Colors appear only when the output goes to a terminal and [`NO_COLOR`](https://no-color.org/) is not set. In the case that [`FORCE_COLOR`](https://force-color.org/) is set, it overrides both. Note that `FORCE_COLOR=0` turns colors off, and any other value turns them on, even when piped. Piped text is plain otherwise, but its layout may change between versions. Scripts should use `--json` to get reliable output.

### Confirmations

Commands like `project delete`, `task delete`, etc. ask for confirmation before deleting, and `restore` asks before replacing the board. Use `--yes` to skip the prompt:

```sh
zinn task delete MDR-1 --yes
zinn task delete MDR-1 --yes --json
```

- With `--json`, `--yes` is **required**. Without it, the command exits with an error and changes nothing.
- When nothing answers the prompt, as in CI or with input redirected from an empty source, a command without `--yes` counts as declined: it prints `Deletion cancelled …` (or `Restore cancelled …`) and exits with code 0. Scripts that delete or restore should always use `--yes`.
- `task relation delete` is consider a low consequence action, so it never asks for confirmation and does not accept `--yes`.

## Help

Use root or namespace help to discover commands, then open a command's help for its arguments and behavior:

```sh
zinn --help
zinn project --help
zinn project column --help
zinn task --help
zinn task move --help
```

The short `-h` form works in the same positions.

Running `zinn` without a command shows help

## Task priority

Priority is optional: `low`, `medium`, `high`, or `urgent`. New tasks have no assigned priority by default.

```sh
zinn task create MDR --title "Review the numbers" --priority high
zinn task edit MDR-1 --priority urgent
zinn task edit MDR-1 --priority none
```

Use `none` to clear priority. Task lists show priority in a compact column after the board column: `-` for unassigned and `L`, `M`, `H`, or `U` for low, medium, high, or urgent. Priority does not affect board ordering.

## Activity

Zinn keeps an activity log of task changes such as creating, editing, moving, reordering, archiving, unarchiving and deleting a task, its labels, its relations, and its comments. Project, column, and global label definition changes are recorded too. Each log also says _who_ made the change.

Deleting a project records one project deletion rather than separate deletion activity for every cascaded row.
Note that this data is not yet surfaced by any command yet.

When a coding agent performs a mutation with `zinn`, the change is recorded under that agent's name.

Zinn recognizes Claude Code, Codex, OpenCode, Gemini CLI, Cline, Cursor, Copilot's coding agent, Crush, Amp, and any tool that sets `AI_AGENT`. If you are using a tool that Zinn does not recognize, you can set `AI_AGENT` in that tool's environment settings, for example `AI_AGENT=hermes`. Otherwise, Zinn uses your git `user.name` and `user.email`, and if that's also not set, it falls to your system username.
