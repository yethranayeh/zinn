# @zinn-dev/core

The shared logic and SQLite storage for [Zinn](https://github.com/yethranayeh/zinn). Core manages projects, columns, tasks, labels, relations, comments, and activity, along with database backups and upgrades.

> [!IMPORTANT]
> **Experimental.** The API and database schema will likely change often between releases until stable.
> Save a backup before upgrading.

## Install

```sh
bun add @zinn-dev/core
```

Requires [Bun](https://bun.sh).

## Usage

Configure the database before the first operation. Mutations require an explicit actor:

```ts
import { configureDatabase, project, task, type Actor } from "@zinn-dev/core";

configureDatabase({
	client: "example",
	version: "0.1.0",
	executable: import.meta.path,
	release: "source",
	allowsLegacyRead: false
});

const actor: Actor = { name: "Alper", email: null, kind: "human" };
const app = project.create({ key: "APP", name: "My project" }, actor);
const createdTask = task.create({ project_id: app.id, title: "Ship the first feature" }, actor);

console.log(createdTask.key); // APP-1
console.log(task.getAll({ projectKey: app.key }));
```

Save this as `example.ts` and run it with a new Zinn directory:

```sh
ZINN_DIR=./.zinn-example bun example.ts
```

Core opens the database on first use. By default it shares `~/.zinn/data/zinn.sqlite` with the CLI, but `ZINN_DIR` and settings files can choose another location. See [data location](../../README.md#data-location).

The example runs as a source script. Clients pass their own `release` identity: `source` for development and `published` for prepared release artifacts. Core independently identifies its own build.

Core throws errors while clients handle output, prompts, and the optional database wait and legacy-read callbacks.

## Shared behavior

Names and titles are trimmed and cannot be blank or contain line breaks or control characters.

- Edits change only supplied fields. Valid edits that leave values unchanged preserve modification timestamps and record no activity.
- Descriptions default to `null`. Passing `null` or blank text clears them. Truthy/non-blank text input keeps its whitespace.
- Entity mutations record the actor and activity in the same transaction as the change.
- Bulk task moves, archives, and unarchives apply in input order and succeed or fail together.

The [public exports](index.ts) provide operations, input types, validation schemas, and errors. Consult the [operation implementations](src/operations) for individual behavior.

## Database compatibility

Opening a database can upgrade it, even for a read operation. Upgrades save a backup first and apply completely or not at all.

Upgrades and restores check that foreign keys reference existing tables and rows before committing.

- Older databases upgrade automatically when both core and the client are published releases, or when `ZINN_DIR` selects a separate database. Source clients otherwise open older databases read-only until an explicit `migrate.run`.
- Databases newer than core supports open read-only.
- Databases without a schema version are refused unless `allowsLegacyRead` enables best-effort, read-only access.

`backup.create` saves a complete database snapshot. `backup.restore` restores the whole database and saves the current data first when present. Backups remain available independently of the normal database-opening policy.
