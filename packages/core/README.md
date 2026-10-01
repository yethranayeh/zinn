# @zinn-dev/core

Shared logic for [zinn](https://github.com/yethranayeh/zinn)

> [!IMPORTANT]
> Zinn is in rapid development, and this package's API and database schema _can_ and **will** change between versions.
> There is no migration system yet. Instead, when a release changes the schema, Zinn will try to run as if everything is aligned with its current version.
> If you have an established board, run `zinn backup` before upgrading.

## Concurrent access

Connections use WAL mode and a 30-second SQLite busy timeout, set before WAL and schema initialization. Core mutations use immediate transactions, acquiring the write lock before reading the state they will change.

Initialization retries only `SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY`, and `SQLITE_IOERR_TRUNCATE`, with at most five total attempts and 20/40/60/80 ms backoff. No new retry starts once one second has elapsed, so a long SQLite wait is not repeated. Failed initialization connections are closed.

Errors retain their original cause and include its message and code. The busy timeout applies to each lock acquisition, not the whole operation. Mutations are not replayed after failure.

Concurrent access is for processes on the same machine using a local filesystem. Initial directory/config creation tolerates concurrent callers and preserves existing settings.

## Descriptions

Projects, tasks, and labels store `description: string | null`. If a description is omitted during creation, it defaults to `null`. _Falsy_ strings are interpreted as `null`. Text containing a non-whitespace character is preserved exactly, including leading and trailing whitespace.

Explicit `null`, `""` or whitespace-only input clears the description. Omitting it on edit leaves the current value unchanged. Normalization happens before change detection and activity recording, so clearing an already absent description writes nothing, records no activity, and leaves existing timestamps unchanged. Public create/edit schemas return normalized values, and their input types allow descriptions to be omitted.

## Task results

Though the tasks do not natively carry thier `key` value in a column, public task reads and mutations return tasks with a derived `key`, like `APP-1`.

Internally, the DB functions still return task rows without `key`. Relation lookups include task records with keys when called with `{ include: { tasks: true } }`.

## Task search

`task.getAll({ projectKey?, archive?, labelNames? })` lists tasks in board order. `labelNames` requires every specified global label; names are case-insensitive and unknown names are errors.

`task.search({ query, projectKey?, archive?, limit?, labelNames? })` searches task titles, descriptions, and comments. It returns `{ tasks, hiddenArchivedCount }`, where `tasks` are tasks with keys.

- `query` cannot be blank. Each whitespace-separated word matches the start of a word, ignoring case and accents, and every word must match in the task's title, description, or comments.
- If the trimmed query is an existing task key, that task comes first. The rest are ordered by bm25 relevance, with the title weighted three times the description and comments, then by project key and task number.
- `projectKey` limits results to one project and must exist. `archive` is `"active"` (default), `"archived"`, or `"all"`. `labelNames` requires every specified label. These filters also apply to a task found by its key. `limit` is a positive integer and caps the number of tasks returned.
- `hiddenArchivedCount` is the number of archived matches left out by the `"active"` filter, whatever the `limit`. It is `0` for `"archived"` and `"all"`.

The index is an FTS5 table, `task_search`, with one row per task, kept in sync by the core operations that change a task's title, description, or comments.

## Activity

Mutations that change tasks, projects, columns, global label definitions, relations, or comments require an actor and write activity in the same transaction.

Project deletion produces one aggregate project activity row. Its snapshot contains the project's key and name, ordered columns as `{ id, name }`, and active and archived tasks as `{ id, key, title }`. SQLite's cascaded task, column, relation, comment, label-attachment, and search-row deletions do not produce individual deletion activity.

## Task priority

Tasks store `priority: TaskPriority | null` and `TaskPriority` is `"low" | "medium" | "high" | "urgent"`.
You can optionally provide a task priority during `create`, but by default it is `null`.

Changing or clearing priority updates `updated_at`. If the current priority is given as the only edit value, `updated_at` does not change.

## Parent and child tasks

`relation.create({ sourceTaskKey: "APP-2", targetTaskKey: "APP-1", relation_type: "subtask" }, actor)` makes the source a child of the target. Each task has at most one parent and any number of children. A nested type of relationship is allowed, so a task can have both a parent and a child. Remove the old relation before assigning another parent.

Cross-project and archived tasks are supported. Creation and removal use the existing relation activity records on both tasks. Task deletion removes links, preserving connected tasks. Moving or archiving a parent does not change its children.

## Backups

`backup.create({ client, version })` saves a copy of the database to `backups/` in the Zinn directory and returns `{ path }`. The file is named `<UTC time>-<client>-<version>.sqlite`, for example `2026-09-29T12-30-05Z-cli-0.32.0.sqlite`. `client` and `version` identify the program using core that makes the backup, such as the CLI and its package version.

The copy is made with SQLite's `VACUUM INTO`, so it is a single file that includes changes still in the WAL file. It throws when there is no database, instead of creating one, and when the file already exists. It records no activity.
