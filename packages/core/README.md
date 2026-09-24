# @zinn-dev/core

Shared logic for [zinn](https://github.com/yethranayeh/zinn)

> [!IMPORTANT]
> Zinn is in rapid development, and this package's API and database schema _can_ and **will** change between versions.
> There is no migration system yet. Instead, when a release changes the schema, Zinn will try to run as if everything is aligned with its current version.
> If you have an established board, keep a copy of `~/.zinn/data/` before migrating it yourself.

## Task results

Though the tasks do not natively carry thier `key` value in a column, public task reads and mutations return tasks with a derived `key`, like `APP-1`.

Internally, the DB functions still return task rows without `key`. Relation lookups include task records with keys when called with `{ include: { tasks: true } }`.

## Task priority

Tasks store `priority: TaskPriority | null` and `TaskPriority` is `"low" | "medium" | "high" | "urgent"`.
You can optionally provide a task priority during `create`, but by default it is `null`.

Changing or clearing priority updates `updated_at`. If the current priority is given as the only edit value, `updated_at` does not change.
