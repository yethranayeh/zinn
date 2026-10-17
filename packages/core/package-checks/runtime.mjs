// Runs one domain operation through the installed core and checks it chose this runtime's SQLite adapter.
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import * as core from "@zinn-dev/core";

const adapter = typeof Bun === "undefined" ? "node" : "bun";
const coreUrl = import.meta.resolve("@zinn-dev/core");
const { getDb } = await import(new URL("src/db.js", coreUrl).href);
const { driver } = await import(new URL(`src/sqlite/${adapter}.js`, coreUrl).href);

core.configureDatabase({
	client: "installed check",
	version: "1.0.0",
	executable: "runtime.mjs",
	release: "published",
	allowsLegacyRead: false
});

const actor = { name: "installed check", email: "check@example.test", kind: "agent" };
const project = core.project.create({ key: "CORE" }, actor);
const task = core.task.create({ project_id: project.id, title: "Installed core" }, actor);

assert.equal(core.task.getByKey(task.key).title, "Installed core");
assert.equal(getDb().driver, driver, "Core selected the wrong SQLite adapter");
getDb().close();

console.log(JSON.stringify({ adapter, core: fileURLToPath(coreUrl) }));
