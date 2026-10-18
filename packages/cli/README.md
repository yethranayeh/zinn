# @zinn-dev/cli

The `zinn` command-line interface.

> [!IMPORTANT]
> **Experimental.** Commands, output, and the database schema will likely change often between releases until stable.
> Run `zinn backup` before upgrading. See [upgrade the database](#upgrade-the-database).

## Install

```sh
npm i -g @zinn-dev/cli
```

Requires [Node.js](https://nodejs.org/) 24.15.0 or newer.

For a first project and task, see the [quick start](../../README.md#quick-start).

Zinn stores projects and tasks in the shared local database at `~/.zinn/data/zinn.sqlite`.
Set `ZINN_DIR` to use another Zinn directory and keep using the same value for commands that should share that database. A relative `ZINN_DIR` stays relative to the current folder. A settings file can also choose the directory (see [Settings files](#settings-files)).

## Settings files

With `ZINN_DIR` set, Zinn uses `data/zinn.sqlite`, `backups/`, and `settings.json` inside that directory. That `settings.json` is the sole configuration file for the invocation, which means its `defaultProject` applies to that store. `ZINN_DIR` also takes precedence over `storage.directory` in that file.

Without `ZINN_DIR`, Zinn reads two optional settings files:

- `settings.json` in `~/.zinn` holds the global settings.
- `zinn.local.json` holds the settings for one codebase. Zinn uses the nearest one, from the current folder up to the Git root. Outside a Git repository it checks only the current folder.

`zinn.local.json` is personal, since it holds paths from one machine, and is not meant to be committed. Without `ZINN_DIR`, Zinn reads it whether or not git ignores it and merges it over the global file, field by field. A missing file is fine, and Zinn creates no settings file.

The files are plain JSON, without comments:

```json
{
	"$schema": "https://zinn.sh/schemas/settings/v1.json",
	"defaultProject": "MDR",
	"storage": {
		"directory": "~/work/zinn-data"
	}
}
```

`$schema` is optional and lets editors handle autocomplete and check the file, but Zinn itself ignores it. New settings are added to the same number and is bumped only when changes that would make existing files invalid. An unknown key, a value of the wrong type or invalid JSON in a selected settings file stops commands with an error that names the file, except for the inspection report below. Zinn _does not fall back to the defaults_.

`storage.directory` names a Zinn directory with the same layout as `ZINN_DIR`: `data/zinn.sqlite` and `backups/`. The first of these that is set decides the directory: `ZINN_DIR`, `storage.directory` in `zinn.local.json`, `storage.directory` in the global `settings.json`, then `~/.zinn`. A relative path is relative to the folder of the file that sets it. A leading `~` or `~/` means your home folder.

`defaultProject` names the project used when its key is omitted from `task create`, `task list`, `task search`, `project view`, `project column list`, `project edit`, or `project delete`. Project keys are matched case-insensitively. A key typed in the command wins, then the local setting, then the global setting. A local file that omits this field keeps the global value; `null` is not accepted.

Without a default, `task list` and `task search` cover every project, and the other commands require a key. When a configured default names a missing project, commands using it fail with an error naming the key and its settings file.

On `task list` and `task search`, `--all-projects` covers every project, overriding the default, and works with `--all` or `--archived`. It cannot be combined with a typed project key. Commands taking a task key use the project named by that key. Column creation, editing, and ordering require an explicit project key.

### Inspection

```sh
zinn info
zinn info --json
```

`info` reports the selected store and database path, the settings files and their sources, the configured default project, the database schema state, and CLI, core and runtime versions. Local settings discovery stops at the nearest `zinn.local.json`. With `ZINN_DIR`, home and codebase settings are marked as not read.

An unusable settings file displays errors, and a missing store or database and database read errors are reported with exit code 0. Note that SQLite may perform normal file housekeeping and crash recovery when this command is called.

With `--json`, the report is one object that always has the same keys:

- `settingsFiles` lists each settings file with its `path`, its `source` (`env` for `ZINN_DIR/settings.json`, `global` or `local`) and its `state`: `found` (with the file's `settings`), `missing`, `error` (with an `error` string) or `not-read` (with `reason: "ZINN_DIR"`). With `ZINN_DIR`, the list holds `ZINN_DIR/settings.json` and the home and codebase files marked `not-read`.
- `storage` holds the store `directory`, its `source` (`env`, `local`, `global` or `default`), the `settingsPath` of the file that chose it (`null` for `env` and `default`), whether the directory `exists`, and an `error`.
- `defaultProject` holds the `key`, the `settingsPath` of the file that set it, and an `error`. `key` and `settingsPath` are `null` when no default is configured.
- `database` holds its `path`, its `state`, the schema `version` it has, and the `latestVersion` this CLI reaches. `state` is `absent` (no file), `empty` (a file with no tables), `unmarked` (tables but no schema version), `current`, `older` or `newer` (compared with `latestVersion`), or `unavailable`. `version` is `0` for `absent`, `empty` and `unmarked`.
- `versions` holds `cli`, `core` and `runtime` (`name` and `version`).

`unavailable` means the database could not be inspected: an unusable settings file left the store undecided (`path` and `version` are `null`), or the file could not be read as a database (`path` is set, `version` is `null`, and `error` says why). Every `error` is `null` when there is no problem. A settings file's error is carried on `storage`, `defaultProject` and `database` as well as on its `settingsFiles` entry, so the same string can appear on several fields. With `ZINN_DIR`, an unusable `ZINN_DIR/settings.json` sets only `defaultProject.error`, since the store is already chosen.

```json
{
	"settingsFiles": [
		{
			"path": "/home/me/.zinn/settings.json",
			"source": "global",
			"state": "found",
			"settings": { "defaultProject": "DEMO" }
		},
		{ "path": "/work/app/zinn.local.json", "source": "local", "state": "missing" }
	],
	"storage": {
		"directory": "/home/me/.zinn",
		"source": "default",
		"settingsPath": null,
		"exists": true,
		"error": null
	},
	"defaultProject": { "key": "DEMO", "settingsPath": "/home/me/.zinn/settings.json", "error": null },
	"database": {
		"path": "/home/me/.zinn/data/zinn.sqlite",
		"state": "current",
		"version": 2,
		"latestVersion": 2,
		"error": null
	},
	"versions": { "cli": "0.41.0", "core": "0.30.0", "runtime": { "name": "Node", "version": "22.0.0" } }
}
```

## Editing conventions

Edit commands change only the fields you supply, whereas omitted fields keep their current values. At least one edit field is required. After input normalization, a valid edit that leaves all values unchanged succeeds without writing changes, updating modification timestamps, or recording activity.

Move, order, archive, unarchive, and task-label attachment commands also succeed without changes when the requested state is already satisfied. This does not apply to creation: creating an existing relation, for example, is an error.

Names and titles are trimmed and cannot be blank or contain line breaks or control characters, such as tabs.

Project, task, and label descriptions may contain multiple lines. Omitted descriptions on creation, empty strings, and whitespace-only strings are stored as `null`. Text containing a non-whitespace character is preserved exactly, including leading and trailing whitespace. Use `--description ''` on an edit to clear a description. JSON returns the full text or `null`.

To change part of a description, or of a comment's text, `--append` and `--replacing` modify how `--description` (or `--text` on `task comment edit`) is applied to the stored text:

```sh
zinn task edit MDR-1 --description 'Bring waffles.' --append
zinn task edit MDR-1 --description 'new sentence' --replacing 'old sentence'
zinn project edit MDR --description database --replacing board --all
```

Flags:

- `--append` adds the text as a new paragraph,
- `--replacing <old>` replaces the one place where `<old>` appears, matching exactly and respecting case.
- `--all` replaces every match.

A command with no match, or with several matches and no `--all`, fails without changing anything.
An empty text with `--replacing` deletes the match. `--append` and `--replacing` cannot be combined.

## Text values

A value that begins with a dash, such as a Markdown bullet, must be joined to its flag with `=`. Otherwise the command fails without changing anything:

```sh
zinn task edit MDR-1 --description='- Bring waffles.' --append
```

For multi-line text, such as Markdown, pass a heredoc with a quoted delimiter (`'EOF'`) in bash or zsh. The shell then passes `$`, backticks, quotes and leading dashes as written:

```sh
zinn task edit MDR-1 --description="$(cat <<'EOF'
- Bring waffles.
- Count the `numbers` for $5 and "Kier".
EOF
)"
```

`$(...)` drops trailing line breaks, so the stored text ends with the last character of the last line.

## Words and repeated flags

`--` ends the options. Every word after the first `--` is considered a plain word, even a secondary instance of `--` or anything else that starts with a dash. Flags after it, such as `--json`, are not read. A trailing `--` changes nothing:

```sh
zinn project column create MDR -- -later
zinn task search -- -flag
```

A flag can be given once.
Only these flags repeat:

- `--label` on `task create`, `task list` and `task search`,
- `--depends-on` and `--related` on `task create`,
- `--add-label` and `--remove-label` on `task edit`.

Any other flag given twice, `--json` and `--yes` included, **fails** without changing anything.
A help flag is the _exception_: the first one shows help and the rest of the line is ignored, so `-h --help` works and help is given whenever needed! No problem!

## Changing tasks in bulk

`task move`, `task archive` and `task unarchive` accept multiple task keys, so several tasks can be changed in one command:

- Tasks are changed in the order given.
- If any task fails, for example because of an unknown key, none change.
- A task already in the requested state is unchanged, with a note on stderr. This includes a key given twice: by its second occurrence, the task is already in the requested state.
- With `--json`, one task prints an object and several print an array. Each task has a `changed` field, which is `false` when the task was already in the requested state.

## Concurrent access

Commands on the same machine can share a database on a local filesystem. Zinn waits up to 30 seconds for each lock acquisition, then fails if the lock is still held. The command's total running time can exceed 30 seconds.

## Start a project

Create a project with a key and optionally provide a name and description:

```sh
zinn project create MDR --name 'Macrodata Refinement' --description 'Refine macrodata'
```

Project keys are stored in uppercase. An omitted name defaults to the key.

Descriptions print in full with `project view`. See [Editing conventions](#editing-conventions) for name validation and description storage and clearing.

Each project starts with _Backlog_, _TODO_, _In Progress_, _Review_, and _Done_ columns.

You can list projects or inspect a project's columns with:

```sh
zinn project list
zinn project view MDR
zinn project column list MDR
```

`project view` shows the project's description and task counts. Use `zinn task list <project-key>` to read its tasks.

`project view` and `project column list` accept an omitted project key when [defaultProject](#settings-files) is configured.

`project column list` counts unarchived tasks. With `--json`, it returns `[{ "name": "Backlog", "taskCount": 3 }, ...]`.

Edit a project:

```sh
zinn project edit MDR --name 'Macrodata Refinement (Morning Shift)'
zinn project edit MDR --description 'Meet the quarterly quota'
zinn project edit MDR --description ''
```

Provide `--name`, `--description`, or both.
The project key can be omitted when [defaultProject](#settings-files) is configured.
See [Text values](#text-values) for values that begin with a dash and multi-line text.

Add another column at the end of the board:

```sh
zinn project column create MDR Boardlog
```

Rename a column:

```sh
zinn project column edit MDR 'In Progress' --name Refining
```

Column names follow the shared [name and title rules](#editing-conventions) and match case-insensitively. Names must be unique within the project; changing only the casing is allowed. Renaming keeps tasks in the column.

Change a column's position on the board:

```sh
zinn project column order MDR Review first
zinn project column order MDR Review previous
zinn project column order MDR Review next
zinn project column order MDR Review last
zinn project column order MDR Review before 'In Progress'
zinn project column order MDR Review after Done
```

Directions follow board order: `first` is the start of the board and `last` is its end.
Moving a column to the position it already has, or before or after itself, does nothing. Tasks stay in their columns.

`zinn project delete MDR` asks for confirmation, then permanently deletes the project and all of its columns and tasks. `--yes` skips confirmation when the project key is **typed**. With an _omitted_ key and [defaultProject](#settings-files), it always asks: `--yes` is ignored with a warning, and without a terminal the command refuses with exit code 1. With `--json`, type the key and pass `--yes` (see [Confirmations](#confirmations)).

## Create and read tasks

Create a task with a title and an optional description. Titles follow the shared [name and title rules](#editing-conventions). New tasks enter the project's first column:

```sh
zinn task create MDR --title 'Refine 75% of the numbers'
zinn task create MDR --title 'Review the employee handbook' --description 'Prepare for a 75% Dance Experience'
```

The project key can be omitted when [defaultProject](#settings-files) is configured.

`--column <name>` starts the task at the bottom of a specific column. The column name matching is case insensitive:

```sh
zinn task create MDR --title 'Compile the Lexington letters' --column 'In Progress'
```

Tasks are created with keys such as `MDR-1`. Task numbers increase in creation order within each project. List active tasks, optionally limited to one project, or view one task:

```sh
zinn task list
zinn task list MDR
zinn task list --all-projects
zinn task list MDR --label CLI --label Groom
zinn task list MDR --column 'In Progress'
zinn task list --column Done --all
zinn task view MDR-1
zinn task view MDR-1 --history
```

Task lists are previews, so they _omit_ descriptions, but `task view` prints the full description.

An omitted project key uses [defaultProject](#settings-files), or every project when none is configured. `--all-projects` overrides the default.

`task view --history` includes the inspected task's recorded activity, newest first by time, then event ID. Reorders and comment changes are included. Use `activity view <activity-id>` for full recorded changes. See [Activity](#activity) for timestamps, event IDs, and record fields.

With `--history --json`, the task gains an `activity` array of full activity records. It returns `[]` when no events are recorded. Without `--history`, this field is _omitted_.

If a project is deleted and recreated with the same key, `task view --history` shows only the _current_ task’s history. `activity list --task <key>` can also show history for **deleted tasks** that previously had that same key.

Repeat `--label <name>` to require every specified label. Matching ignores case.

Use `--column <name>` to filter by an exact column name, ignoring case, within one project or across projects. Column, label, and archive filters apply together. No matches is a successful empty result (`[]` with `--json`).

## Search tasks

Search task titles, descriptions, and comments, optionally in one project:

```sh
zinn task search refine
zinn task search refine --all-projects
zinn task search 'quarterly quota' MDR
zinn task search MDR-1
zinn task search auth --all --limit 5
zinn task search auth MDR --label cli
```

Each query matches the start of a word, ignoring case and accents, so `cafe` finds "Café" and `auth` finds "Authentication". Every word must match somewhere in the task: its title, its description, or any of its comments. A comment match lists the task the comment belongs to.

The query comes first, then the optional project key. An omitted key uses [defaultProject](#settings-files), or every project when none is configured. `--all-projects` overrides the default.

If the whole query is an existing task key, such as `mdr-1`, that task comes first. Other results follow by relevance, with title matches weighted highest. Equally relevant tasks are ordered by project key, then task number.

An exact task-key query overrides the configured default project. A project key supplied after the query still filters the search.

Search defaults to active tasks. `--archived` searches archived tasks and `--all` searches both. A note on stderr reports hidden archived matches. `--limit <n>` caps the results.

`--label` works as it does for `task list`: repeat it to require every specified label. Label filtering happens before `--limit` and before archived matches are counted.

With `--json`, search returns an array of tasks like `task list` does. A search with no results succeeds. A query that begins with a dash goes after `--` (see [Words and repeated flags](#words-and-repeated-flags)).

Search uses an index that Zinn keeps up to date as tasks and comments change. `zinn reindex` rebuilds it from the tasks and their comments, archived tasks included:

```sh
zinn reindex
```

Only the index changes, completely or not at all, so no backup is saved. With `--json`, it prints `{ "databasePath": "...", "taskCount": 12 }`. The command fails without changing anything when there is no database yet, or when Zinn refuses changes to the database, such as one with a newer schema version (see [Upgrade the database](#upgrade-the-database)).

## Labels

Labels are global and reusable across projects.

```sh
zinn label create urgent --color red --description 'Needs attention soon'
zinn label create review
zinn label edit review --name ready --color green
zinn label list
```

### Adding to tasks

```sh
zinn task create MDR --title 'Check the numbers' --label urgent --label review
zinn task label add MDR-1 urgent review
zinn task label remove MDR-1 review
zinn task edit MDR-1 --add-label review --remove-label urgent
```

Repeat `--label`, `--add-label`, or `--remove-label` for several labels. Each value is one name, so commas are part of the name. Quote names containing spaces: `--label 'needs review'`.

Label names follow the shared [name and title rules](#editing-conventions), preserve their stored casing, and match case-insensitively. Changing only the casing is allowed; names that differ only in case _cannot_ coexist.

Label colors default to white. Available colors are _red_, _green_, _yellow_, _blue_, _magenta_, _cyan_, _white_, and _gray_.

`--json` includes each label's color as a value.

`label edit` accepts name, color, and description. Renaming preserves every task attachment because attachments refer to the label's internal ID. Updating a label definition does not affect attached tasks' timestamps.

Task creation and edits apply content and label changes together, or roll back together on failure.
Changing a task's label attachments updates that task's modification timestamp. Archived tasks can also have their labels edited.

`--json` lists a task's labels as names.

`zinn label delete urgent` asks for confirmation, then deletes the definition and removes it from every task. Declining confirmation leaves the label and its attachments unchanged. `--yes` skips the confirmation (see [Confirmations](#confirmations)).
Use `task label remove` to remove a label attachment from one task instead. Task/project deletion cleans up label attachments, but does not affect labels themselves.

## Task relations

```sh
zinn task relation create MDR-1 MDR-2 --type dependency
zinn task relation create MDR-1 MDR-2 --type duplicate
zinn task relation create MDR-1 OTHER-1 --type related
zinn task relation list MDR-1
```

`dependency` means the first task depends on the second; `duplicate` means the first is a duplicate of the second. `related` is symmetric.

Relations do not automatically move, complete, or archive tasks.
Tasks from separate projects can be related to each other. Tasks can also be related to archived tasks.

JSON relation arrays from `task relation list` and `task view` are ordered by creation timestamp ascending, then relation ID ascending for ties.

Use `zinn task relation create APP-2 APP-1 --type subtask` to make APP-2 a child of APP-1. Each task can have one parent and any number of subtasks, including nested subtasks.

Remove the existing subtask relation before assigning a different parent. Moving or archiving a parent does not change its children, and deleting a parent removes its child relations while retaining child task data.

`task create` can relate the new task with `--parent`, `--depends-on`, `--duplicate-of` and `--related`. Repeat `--depends-on` and `--related` to relate several tasks:

```sh
zinn task create MDR --title 'Sort the files' --parent MDR-1 --depends-on MDR-2
```

Remove a relation with `zinn task relation delete MDR-1 MDR-2 --type dependency`, using its original direction for `dependency`, `duplicate`, and `subtask`. For `related`, order does not matter.
Relation deletion requires no confirmation.

## Task comments

Add and list comments on a task:

```sh
zinn task comment create MDR-1 --text 'Ready for review'
zinn task comment list MDR-1
```

Comments receive keys per task like `MDR-1#1`.

View, edit or delete a comment using its key:

```sh
zinn task comment view 'MDR-1#1'
zinn task comment edit 'MDR-1#1' --text Approved
zinn task comment delete 'MDR-1#1'
```

`task comment view` shows the current text in full, keeping its line breaks, including on archived tasks. With `--json`, it returns one object with `key`, `text`, `created_at` and `updated_at`.

Deletion asks for confirmation, unless `--yes` is used (see [Confirmations](#confirmations)). Comments can be added to archived tasks. Comment mutations are recorded in the activity log without changing the task's modification timestamp.

## Edit tasks

Edit a task's title, description, priority, or labels:

```sh
zinn task edit MDR-1 --title 'Meet the quarterly refinement quota'
zinn task edit MDR-1 --description 'Complete refinement before the waffle party'
zinn task edit MDR-1 --title 'Meet the quarterly refinement quota' --description ''
```

See [Editing conventions](#editing-conventions) for title validation, partial edits and clearing descriptions.

Archived tasks can be edited without unarchiving them.
See [Text values](#text-values) for values that begin with a dash and multi-line text.

## Move and order tasks

Move a task to another column in its project:

```sh
zinn task move MDR-1 'In Progress'
```

A moved task appears at the bottom of its destination column. Moving it to its current column does nothing. Archived tasks must be unarchived before they can be moved.

For multiple tasks, give their keys before the column. They move in input order; tasks already in that column retain their positions. Each task's column is looked up in its own project:

```sh
zinn task move MDR-1 MDR-2 APP-4 'In Progress'
```

See [Changing tasks in bulk](#changing-tasks-in-bulk).

Change a task's position within its current column:

```sh
zinn task order MDR-2 top
zinn task order MDR-2 up
zinn task order MDR-2 down
zinn task order MDR-2 bottom
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

`--archived` and `--all` cannot be used together.

Unarchiving puts a task at the bottom of its previous column:

```sh
zinn task unarchive MDR-1
zinn task unarchive MDR-2 MDR-3
```

Archive or unarchive multiple tasks by giving several keys. Unarchived tasks land in the order given. See [Changing tasks in bulk](#changing-tasks-in-bulk).

Delete a task permanently with `zinn task delete MDR-1`. It asks for confirmation before performing the action, unless `--yes` is used (see [Confirmations](#confirmations)).

Deleting a task does not make its number available again within that project. Deleting and recreating the project starts its task numbering again at 1.

## Task priority

Priority is optional: `low`, `medium`, `high`, or `urgent`. Priority values, including `none`, are case-insensitive. Stored values and JSON use lowercase. New tasks have no assigned priority by default.

```sh
zinn task create MDR --title 'Review the numbers' --priority high
zinn task edit MDR-1 --priority urgent
zinn task edit MDR-1 --priority none
```

Use `none` to clear priority. Priority does not affect board ordering.

## Activity

Zinn records changes to tasks, projects, columns, labels, relations, and comments, including who made them.

Deleting a project records one project deletion rather than separate deletion activity for every cascaded row.

```sh
zinn activity list
zinn activity list --limit 10
zinn activity list --task MDR-1
zinn activity list --session conversation-id
zinn activity list --session conversation-id --thread child-thread-id
zinn activity view 019abcdf-1234-7
```

`--limit` caps the newest matching events and must be a positive safe integer. Reorders and both affected-task events from relation changes are included.

`--task` includes active, archived, and deleted tasks by readable key, with history recovered from current tasks and recorded deletion snapshots. A reused key includes all known task lifetimes. A project deletion that removed the task is included as the original project event. A valid key with no recoverable history returns an empty list.

`--session` and `--thread` match the complete stored IDs exactly, including case and whitespace. All supplied filters must match, and `--limit` applies after filtering. Rows without the requested identity do not match. No matches return empty output, or `[]` with `--json`, and exit successfully. Session activity records committed changes.

`activity view` accepts a full UUID or a unique prefix of at least eight hexadecimal digits for convenience. The match ignores case and accepts both the full hyphenated or compact forms. Prefixes must be unique across all activity. Use a full ID for reliable reference results. Using prefixes may result in unreliable results over time as history grows.

`activity view` preserves full recorded text and line breaks, including unknown change fields.

With `--json`, list returns an array and view returns one event object. Both include `id`, `created_at` (epoch milliseconds), `actor_name`, `actor_email`, `actor_kind`, `actor_source`, `actor_session_id`, `actor_thread_id`, `actor_agent`, `actor_model`, `actor_effort`, `entity_type`, `entity_id`, `action`, and `changes` (parsed JSON or `null`). `actor_name` can be `null` for an unnamed agent. The six additional actor fields are `null` when absent, including on events recorded before schema version 2. Payloads and IDs are preserved in full, including after deletion.

> [!WARNING]
> A readable task key can identify different tasks after a project is deleted and recreated. Group JSON records by (`entity_type`, `entity_id`) to keep their histories distinct. The `id` identifies the activity event itself. Project deletion events keep the project's `entity_id`, with removed task IDs in `changes.tasks`.

When a coding agent performs a mutation with `zinn`, the change is recorded under that agent's name.

Zinn recognizes Claude Code, Codex, OpenCode, Gemini CLI, Cline, Cursor, Copilot's coding agent, Crush, Amp, and any tool that sets `AI_AGENT`.

It checks `AI_AGENT`, then `AGENT`, then tool markers, taking the first identifying value. You can declare a name through that tool's environment settings, for example `AI_AGENT=hermes`.

With no marker, Zinn uses your git `user.name` and `user.email`, then your system username. `actor_source` records the deciding `env:<VARIABLE>`, `git-config` or `os-user`.

Integrations can supply `ZINN_SESSION_ID` for the top-level conversation and `ZINN_THREAD_ID` for the execution thread running the command. When either is provided, Zinn uses that pair. Otherwise it uses the first available _native_ pair: `CLAUDE_CODE_SESSION_ID` with a `null` thread, then `CODEX_SESSION_ID` and `CODEX_THREAD_ID`, then OpenCode's `OPENCODE_SESSION_ID` as the thread with a `null` session. If a member is missing, it stays `null` because Zinn never combines pairs. Inherited IDs associate the command with their declared conversation or thread.

`ZINN_AGENT`, `ZINN_MODEL` and `ZINN_EFFORT` declare the host agent name, running model and effort for the execution making the change. When `ZINN_EFFORT` is unset, Zinn records Claude Code's `CLAUDE_EFFORT`. Zinn trims surrounding whitespace, treats blank declarations as _unset_ and preserves other text. These values are declarations rather than authenticated identities. New changes retain them in activity JSON and earlier events keep their recorded attribution.

## Back up the database

It is recommended to save a copy of the database before installing a new version:

```sh
zinn backup
```

The snapshot goes to `backups/` in the Zinn directory. It includes all committed changes and can be taken while Zinn is in use. Existing backups are never overwritten. With `--json`, the command returns `{ "path": "..." }`. It fails when there is no database yet.

## Restore the database

Restore the whole database from a backup saved by `zinn backup` or an upgrade:

```sh
zinn restore ~/.zinn/backups/2026-09-29T12-30-05Z-cli-0.32.0-b38178c0.sqlite
```

The command asks for confirmation unless `--yes` is used (see [Confirmations](#confirmations)). It saves the current database first, then restores completely or not at all. Restoring onto a missing database creates it. With `--json`, it returns `{ "databasePath": "...", "previousVersion": 1, "restoredVersion": 1, "backupPath": "..." }`, where `backupPath` is the saved copy of the previous database, or `null` when it was missing or empty.

A backup with an older schema version is restored at that version, and Zinn then upgrades it like any older database (see [Upgrade the database](#upgrade-the-database)). The restore works whatever the version of the database it replaces, so you can go back to an older Zinn and restore the backup an upgrade saved.

Missing, damaged, unmarked, non-Zinn, or newer-schema backups are refused without changes. Any later failure rolls back the restore and retains the saved backup.

If the database being replaced is damaged, restore leaves it unchanged and prints recovery steps.

## Upgrade the database

The database records a schema version, and a newer Zinn upgrades an older database to its own version. The upgrade is applied completely or not at all, and a backup is saved first, in the same folder as `zinn backup`.

A published release upgrades an older database on first use. Source builds automatically upgrade **only a separate database** chosen through `ZINN_DIR`. Other older databases open in read-only mode. To upgrade explicitly:

```sh
zinn migrate
```

An already-current database is unchanged and saves no backup. With `--json`, the command returns `{ "databasePath": "...", "previousVersion": 1, "finalVersion": 2, "changed": true, "backupPath": "..." }`, where `backupPath` is `null` when nothing changed.

If the upgrade fails, the database is unchanged. The backups taken before each attempt stay in the `backups/` folder. The command fails without attempting anything when there is no database with data yet, when the database has no schema version, or when it is newer than your Zinn.

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
zinn task create MDR --title 'Refine the numbers' --json
```

- Read commands print what they list or show. Write commands print the entity they created, changed, or deleted.
- Output is a single JSON document on stdout. Empty lists print `[]`.
- Handled errors go to stderr as one JSON document, stdout stays empty, and the command exits with code 1: `{ "error": { "code": "not_found", "message": "...", "details": { "entity": "task", "key": "MDR-999", "source": "explicit" } } }`.
- `error.code` is `invalid_input` for invalid invocation or settings, `not_found` for an absent required entity or requested file, `conflict` for a request blocked by current state or database compatibility, `storage` for filesystem or SQLite operational failures, and `internal` for an unexpected failure.
- Optional `error.details` carries known facts: `argument`, `field` (a string/number path), `entity`, `key`, `source` (`explicit` or `defaultProject`), `settingsPath`, `reason`, `matchCount`, `candidateIds`, `path`, `databasePath`, `backupDirectory`, `backupPath`, `schemaVersion`, `supportedSchemaVersion`, and `cause` (`message` and optional native `code`/`errcode`). Unknown facts are omitted.
- Optional `error.help` retains usage guidance. Prior notices are collected in optional `error.diagnostics`, an array of strings. On success, notices print as text on stderr after the command completes. Text-mode notices print immediately. This includes lock waits; JSON commands report their wait only at completion.

Check the exit status before parsing stdout for success or stderr for failure. Message, help and diagnostic wording is for people; scripts use the code and details. Signals, runtime loading failures and broken output channels are outside this handled-error contract.

Scripts should use `--json`. Text is colored only in a terminal unless `NO_COLOR` disables it. `FORCE_COLOR` overrides both: `0` turns color off and any other nonempty value turns it on, including when piped.

`ZINN_DEBUG=1` prints routing details on stderr. Other values do nothing. Stdout, including `--json` output, is unchanged.

### Confirmations

Project, task, label, and comment deletion ask for confirmation, as does restoring the database. Use `--yes` to skip the prompt:

```sh
zinn task delete MDR-1 --yes
zinn task delete MDR-1 --yes --json
```

- With `--json`, `--yes` is **required**. Without it, the command exits with an error and changes nothing.
- Project deletion also requires a typed project key to skip confirmation; a configured default always needs confirmation and cannot be deleted with `--json`.
- Without a terminal, when stdin or stdout is redirected as in CI or a pipe, a command without `--yes` refuses before asking: it changes nothing and exits with code 1. Piped input such as `echo y` does not answer the prompt, so scripts that delete or restore must use `--yes`.
- Declining the prompt in a terminal changes nothing and exits with code 0.
- Confirmation prompts are written to stderr. Press Enter to decline; only `y` or `Y` confirms.
- `task relation delete` never asks for confirmation and does not accept `--yes`.

## Help

Use root or namespace help to discover commands, then open a command's help for its arguments and behavior:

```sh
zinn --help
zinn project --help
zinn project column --help
zinn task --help
zinn task move --help
```

The short `-h` form works in the same positions. `--help` shows help for the command words before it and runs nothing. The rest of the line is ignored.

Running `zinn` without a command shows help. Use `zinn --version` (or `-v`) to print the CLI version.
