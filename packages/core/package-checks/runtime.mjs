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
core.label.create({ name: "runtime" }, actor);
const task = core.task.create({ project_id: project.id, title: "Installed core", priority: "high", labelNames: ["runtime"] }, actor);

assert.equal(core.task.getByKey(task.key).title, "Installed core");
const created = core.activity.getAll({ taskKey: task.key })[0];
assert.deepEqual(core.activity.getAll({
	taskKey: task.key,
	changed: [{ field: "priority", value: "HIGH" }, { field: "labels", value: "RUNTIME" }],
	limit: 1,
}), [created]);
core.task.edit({ taskKey: task.key, priority: null }, actor);
const cleared = core.activity.getAll({ taskKey: task.key })[0];
assert.deepEqual(core.activity.getAll({ taskKey: task.key, changed: [{ field: "priority", value: null }] }), [cleared]);
assert.deepEqual(core.activity.getAll({ taskKey: task.key, changed: [{ field: "labels", value: "runtime" }] }), [created]);

const second = core.task.create({ project_id: project.id, title: "Second" }, actor);
const ordered = core.task.orderMany({ taskKeys: [second.key, task.key], direction: "top" }, actor);

assert.deepEqual(
	ordered.map(({ changed }) => changed),
	[true, false]
);
assert.deepEqual(
	core.task.getAll().map(({ key }) => key),
	[second.key, task.key]
);
core.task.archive(second.key, actor);
assert.throws(() => core.task.deleteMany([task.key, "CORE-99"], actor), core.CoreError);
assert.throws(() => core.task.deleteMany([task.key, task.key.toLowerCase()], actor), core.CoreError);
assert.equal(core.task.getAll({ archive: "all" }).length, 2);
assert.deepEqual(
	core.task.deleteMany([task.key.toLowerCase(), second.key], actor).map(({ key }) => key),
	[task.key, second.key]
);
assert.deepEqual(core.task.getAll({ archive: "all" }), []);
assert.equal(getDb().driver, driver, "Core selected the wrong SQLite adapter");
getDb().close();

console.log(JSON.stringify({ adapter, core: fileURLToPath(coreUrl) }));
