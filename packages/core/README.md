# @zinn-dev/core

Shared logic for [zinn](https://github.com/yethranayeh/zinn)

> [!IMPORTANT]
> **Experimental.** This package's API and database schema _can_ and **will** change between versions.
> A newer Zinn upgrades an older database. Read ([how](#opening-and-upgrading-the-database)).
> Run `zinn backup` before upgrading.

## Editing conventions

Edit operations change only supplied fields; omitted fields retain their values. At least one edit field is required. Schemas normalize input before core compares it with stored values. A valid edit that leaves all values unchanged returns the existing entity without writing changes, advancing `updated_at`, or recording activity.

Move, order, archive, unarchive, and task-label attachment operations also return without changes when the requested state is already satisfied. Creation is different: duplicate relation creation, for example, is an error.

Project and column names reject blank text, control characters, and line separators. Column names are trimmed; project names preserve surrounding spaces. Label names are trimmed and cannot be blank; task titles cannot be blank. Labels and task titles do not currently enforce the project/column single-line rule.

## Bulk operations

`task.moveMany`, `task.archiveMany` and `task.unarchiveMany` are the bulk forms of `task.move`, `task.archive` and `task.unarchive`. They all follow the same rules:

- The singular operation is applied to each key in the order given.
- Either all succeed or none do.
- They return `{ task, changed }` for each key, in the same order. `changed` is `false` when that key was already in the requested state, including a key repeated earlier in the same call.

## Concurrent access

Connections use WAL mode and a 30-second SQLite busy timeout, set before WAL and schema initialization. Core mutations use immediate transactions, acquiring the write lock before reading the state they will change.

Initialization retries only `SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY`, and `SQLITE_IOERR_TRUNCATE`, with at most five total attempts and 20/40/60/80 ms backoff. No new retry starts once one second has elapsed, so a long SQLite wait is not repeated. Failed initialization connections are closed.

Errors retain their original cause and include its message and code. The busy timeout applies to each lock acquisition, not the whole operation. Mutations are not replayed after failure.

Concurrent access is for processes on the same machine using a local filesystem. Initial directory creation tolerates concurrent callers.

## Descriptions

Projects, tasks, and labels store `description: string | null`. If a description is omitted during creation, it defaults to `null`. Empty and whitespace-only strings normalize to `null`. Text containing a non-whitespace character is preserved exactly, including leading and trailing whitespace.

Explicit `null`, `""` or whitespace-only input clears the description. Clearing an already absent description follows the [editing conventions](#editing-conventions). Public create/edit schemas return normalized values, and their input types allow descriptions to be omitted.

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

`reindex.run({ onWait })` recreates `task_search` and fills it from the task and comment records, archived tasks included, then returns `{ databasePath, taskCount }`. It runs in one write transaction after a free-space check, so it applies completely or not at all, and it changes nothing else: no backup is saved and no activity is recorded. It throws when there is no database, and opens the database like any change, so a database that opens read-only throws `ReadOnlyDatabaseError`. `onWait` is called once when it waits for another writer.

## Column task counts

`column.getTaskCountsByProjectKey(projectKey)` returns `{ columns, archivedTaskCount }` without loading the tasks. `columns` holds `{ column, taskCount }` for every column of the project in board order, where `taskCount` counts unarchived tasks and is `0` for an empty column. `archivedTaskCount` is the project's archived tasks across all columns. The project must exist.

## Activity

Mutations that change tasks, projects, columns, global label definitions, relations, or comments require an actor and write activity in the same transaction.

Project deletion produces one aggregate project activity row. Its snapshot contains the project's key and name, ordered columns as `{ id, name }`, and active and archived tasks as `{ id, key, title }`. SQLite's cascaded task, column, relation, comment, label-attachment, and search-row deletions do not produce individual deletion activity.

## Task priority

Tasks store `priority: TaskPriority | null` and `TaskPriority` is `"low" | "medium" | "high" | "urgent"`.
You can optionally provide a task priority during `create`, but by default it is `null`.

Provide `null` to clear priority.

## Parent and child tasks

`relation.create({ sourceTaskKey: "APP-2", targetTaskKey: "APP-1", relation_type: "subtask" }, actor)` makes the source a child of the target. Each task has at most one parent and any number of children. A nested type of relationship is allowed, so a task can have both a parent and a child. Remove the old relation before assigning another parent.

Cross-project and archived tasks are supported. Creation and removal use the existing relation activity records on both tasks. Task deletion removes links, preserving connected tasks. Moving or archiving a parent does not change its children.

## Opening and upgrading the database

The database records a schema version. A client calls `configureDatabase(policy)` once, before the first operation, and core opens the database when an operation first needs it. The policy names the client (`client`, `version` and `executable`, which appear in diagnostics and in backup file names), its `release` mode (read it with `readReleaseMode`), and whether it `allowsLegacyRead`. It can also pass `onWait`, called once when an upgrade waits for another writer, and `onLegacyRead`, called once with the database's path, version and latest version when a database without a schema version opens for reading. Core never prints or prompts, so the client renders both.

- A database without a schema version throws `UnmarkedDatabaseError` before anything is created or changed, unless `allowsLegacyRead` is set. With it, the database opens read-only and a change throws `ReadOnlyDatabaseError` with reason `"unmarked"`. Reads are best effort and may fail or omit data.
- A database with a newer schema version than core reaches opens read-only, with reason `"newer"`.
- An older database is upgraded when it is opened, with a backup saved first, when core and the client both run from published releases, or when the database is not the default one. Otherwise it opens read-only, with reason `"older"`, until `migrate.run({ client, version, onWait })` upgrades it and returns `{ databasePath, previousVersion, finalVersion, changed, backupPath }`. `migrate.run` throws `MigrationRefusedError` without attempting anything when there is no database with data, when it has no schema version, or when it is newer.

## Backups

`backup.create({ client, version })` saves a copy of the database to `backups/` in the Zinn directory and returns `{ path }`. The file is named `<UTC time>-<client>-<version>-<suffix>.sqlite`, for example `2026-09-29T12-30-05Z-cli-0.32.0-b38178c0.sqlite`. `client` and `version` identify the program using core that makes the backup, such as the CLI and its package version. The suffix is the first eight hexadecimal characters of a random UUID and distinguishes backups made at the same time.

The copy is made with SQLite's `VACUUM INTO`, so it is a single file that includes changes still in the WAL file. It throws when there is no database, instead of creating one, and when the file already exists. It records no activity.

`backup.restore({ path, client, version, onWait })` replaces the board with the one in the backup file at `path` and returns `{ databasePath, previousVersion, restoredVersion, backupPath }`. It first saves the current board with `backup.create`, naming `client` and `version`, and returns that copy's path as `backupPath`, or `null` when the database was missing or empty. A missing database is created. The backup is copied into the database inside one write transaction, so it applies completely or not at all, and the database file is never moved or replaced. `onWait` is called once when the restore waits for another writer.

The restore opens the database without the open policy, so it works whatever the database's version. A backup with an older schema version is restored at that version, and the open policy upgrades it later like any older database. `backup.restore` throws `RestoreRefusedError` without changing anything when the file is missing, damaged or not a SQLite database, when the backup has no schema version or a newer one than core reaches, or when its tables are not the ones Zinn creates at its version. The newer-version message names the client and version in the backup's file name. Any later failure rolls back, keeps the saved copy and is thrown as it was. `backup.check({ path, client, version })` throws the same refusals without opening the database, so a client can check a backup before asking for confirmation. Restoring records no activity.
