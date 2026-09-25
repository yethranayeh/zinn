# @zinn-dev/core

Shared logic for [zinn](https://github.com/yethranayeh/zinn)

> [!IMPORTANT]
> Zinn is in rapid development, and this package's API and database schema _can_ and **will** change between versions.
> There is no migration system yet. Instead, when a release changes the schema, Zinn will try to run as if everything is aligned with its current version.
> If you have an established board, keep a copy of `~/.zinn/data/` before migrating it yourself.

## Task results

Though the tasks do not natively carry thier `key` value in a column, public task reads and mutations return tasks with a derived `key`, like `APP-1`.

Internally, the DB functions still return task rows without `key`. Relation lookups include task records with keys when called with `{ include: { tasks: true } }`.

## Task search

`task.search({ query, projectKey?, archive?, limit? })` searches task titles, descriptions, and comments. It returns `{ tasks, hiddenArchivedCount }`, where `tasks` are tasks with keys.

- `query` cannot be blank. Each whitespace-separated word matches the start of a word, ignoring case and accents, and every word must match in the task's title, description, or comments.
- If the trimmed query is an existing task key, that task comes first. The rest are ordered by bm25 relevance, with the title weighted three times the description and comments, then by project key and task number.
- `projectKey` limits results to one project and must exist. `archive` is `"active"` (default), `"archived"`, or `"all"`. Both filters also apply to a task found by its key. `limit` is a positive integer and caps the number of tasks returned.
- `hiddenArchivedCount` is the number of archived matches left out by the `"active"` filter, whatever the `limit`. It is `0` for `"archived"` and `"all"`.

The index is an FTS5 table, `task_search`, with one row per task, kept in sync by the core operations that change a task's title, description, or comments.

## Task priority

Tasks store `priority: TaskPriority | null` and `TaskPriority` is `"low" | "medium" | "high" | "urgent"`.
You can optionally provide a task priority during `create`, but by default it is `null`.

Changing or clearing priority updates `updated_at`. If the current priority is given as the only edit value, `updated_at` does not change.
