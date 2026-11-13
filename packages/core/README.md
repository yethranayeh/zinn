# @zinn-dev/core

The shared operations and SQLite storage for [Zinn](https://zinn.sh).

> [!IMPORTANT]
> **Experimental.** The API and database schema may change between releases. Save a backup before upgrading.

## Install

```sh
npm i @zinn-dev/core
```

Requires [Node.js](https://nodejs.org/) 24.15.0 or newer. Core also runs on [Bun](https://bun.sh).

## Use

Configure the database before the first operation. Mutations require an explicit actor:

```ts
import { fileURLToPath } from "node:url";
import { configureDatabase, project, task, type Actor } from "@zinn-dev/core";

configureDatabase({
	client: "example",
	version: "0.1.0",
	executable: fileURLToPath(import.meta.url),
	release: "source"
});

const actor: Actor = { name: "Example user", email: null, kind: "human" };
const app = project.create({ key: "APP", name: "My project" }, actor);
const createdTask = task.create({ project_id: app.id, title: "Ship the first feature" }, actor);

console.log(createdTask.key); // APP-1
console.log(task.getAll({ projectKey: app.key }));
```

Save the example as `example.ts` and run it against a separate local database:

```sh
mkdir -p ./.zinn-example
ZINN_DIR=./.zinn-example node example.ts
```

Core uses Zinn's shared database, which is normally located at `~/.zinn/data/zinn.sqlite`. Opening an older supported database may upgrade it, so Core saves a backup before an upgrade. See [Data and backups](https://zinn.sh/docs/data) and the [Core library guide](https://zinn.sh/docs/core) for database behavior and library setup.
