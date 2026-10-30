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
const task = core.task.create(
	{ project_id: project.id, title: "Installed core", priority: "high", labelNames: ["runtime"] },
	actor
);

assert.equal(core.task.getByKey(task.key).title, "Installed core");
const created = core.activity.getAll({ taskKey: task.key }).events[0];
assert.deepEqual(
	core.activity.getAll({
		taskKey: task.key,
		changed: [
			{ field: "priority", value: "HIGH" },
			{ field: "labels", value: "RUNTIME" }
		],
		limit: 1
	}).events,
	[created]
);
core.task.edit({ taskKey: task.key, priority: null }, actor);
const cleared = core.activity.getAll({ taskKey: task.key }).events[0];
assert.deepEqual(core.activity.getAll({ taskKey: task.key, changed: [{ field: "priority", value: null }] }).events, [
	cleared
]);
assert.deepEqual(core.activity.getAll({ taskKey: task.key, changed: [{ field: "labels", value: "runtime" }] }).events, [
	created
]);
assert.deepEqual(
	core.activity.getAll({ taskKey: task.key, actions: ["edit"], changed: [{ field: "priority" }] }).events,
	[cleared]
);
assert.deepEqual(
	core.activity.getAll({ taskKey: task.key, changed: [{ field: "title" }, { field: "description" }] }).events,
	[created]
);
core.task.label.remove({ taskKey: task.key, labelNames: ["runtime"] }, actor);
const removed = core.activity.getAll({ taskKey: task.key }).events[0];
const page = core.activity.getAll({ taskKey: task.key, limit: 1 });
assert.deepEqual(page, { events: [removed], hasMore: true });
assert.deepEqual(
	core.activity.getAll({
		taskKey: task.key,
		startingAfter: removed.id.toUpperCase().replaceAll("-", ""),
		limit: 1
	}),
	{ events: [cleared], hasMore: true }
);
assert.deepEqual(
	core.activity.getAll({
		taskKey: task.key,
		startingAfter: cleared.id,
		changed: [{ field: "priority" }],
		limit: 1
	}),
	{ events: [created], hasMore: false }
);
assert.deepEqual(
	core.activity.getAll({ taskKey: task.key, actions: ["edit", "move"], changed: [{ field: "labels" }] }).events,
	[removed]
);
assert.deepEqual(core.activity.getAll({ taskKey: task.key, changed: [{ field: "labels", value: "runtime" }] }).events, [
	created
]);

const second = core.task.create({ project_id: project.id, title: "Second" }, actor);
const request = { sourceTaskKey: task.key, targetTaskKey: second.key, relation_type: "subtask" };
const original = core.relation.create({ ...request, relation_type: "related" }, actor);
const conflicts = core.relation.getConflicts(request);
assert.deepEqual(
	conflicts.map(({ id }) => id),
	[original.id]
);
assert.equal(conflicts[0].source.key, task.key);
assert.equal(conflicts[0].target.key, second.key);
assert.throws(() => core.relation.create(request, actor), core.CoreError);
const replaced = core.relation.create({ ...request, replace: conflicts.map(({ id }) => id) }, actor);
assert.deepEqual(core.relation.getAll(task.key), [replaced]);
const reversed = core.relation.create(
	{ ...request, sourceTaskKey: second.key, targetTaskKey: task.key, replace: true },
	actor
);
assert.equal(reversed.source_task_id, second.id);
assert.equal(reversed.target_task_id, task.id);
const eventsBeforeStaleWrite = core.activity.getAll().events;
assert.throws(
	() => core.relation.create({ ...request, replace: [replaced.id] }, actor),
	(error) => error instanceof core.CoreError && error.kind === "conflict" && error.facts.reason === "relation_changed"
);
assert.deepEqual(core.activity.getAll().events, eventsBeforeStaleWrite);
assert.deepEqual(core.relation.getAll(task.key), [reversed]);
assert.throws(
	() =>
		core.task.create(
			{
				project_id: project.id,
				title: "Conflicting",
				relations: [
					{ relation_type: "dependency", targetTaskKey: task.key },
					{ relation_type: "related", targetTaskKey: task.key.toLowerCase() }
				]
			},
			actor
		),
	core.CoreError
);
assert.equal(core.project.getByKey(project.key).task_count, 2);
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

const listProject = core.project.create({ key: "LIST" }, actor);
const boardFirst = core.task.create(
	{ project_id: listProject.id, title: "Board first", due_at: 10, labelNames: ["runtime"] },
	actor
);
const dueFirst = core.task.create(
	{ project_id: listProject.id, title: "Due first", due_at: 0, columnName: "Done", labelNames: ["runtime"] },
	actor
);
assert.deepEqual(
	core.task.getAll({ projectKey: listProject.key, limit: 1 }).map(({ key }) => key),
	[boardFirst.key]
);
assert.deepEqual(
	core.task.getAll({ projectKey: listProject.key, sort: "due", limit: 1 }).map(({ key }) => key),
	[dueFirst.key]
);
assert.deepEqual(
	core.task
		.getAll({
			projectKey: listProject.key,
			columnName: "done",
			labelNames: ["runtime", "RUNTIME"],
			dueSince: 0,
			dueUntil: 0,
			limit: 1
		})
		.map(({ key }) => key),
	[dueFirst.key]
);

assert.equal(getDb().driver, driver, "Core selected the wrong SQLite adapter");
getDb().close();

console.log(JSON.stringify({ adapter, core: fileURLToPath(coreUrl) }));
