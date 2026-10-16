import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runActivityCheck(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-activity-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, column, task, relation, label, comment, activity } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import * as dbActivity from ${JSON.stringify(new URL("./db/activity.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      const human = { name: "Test Human", email: "human@example.com", kind: "human" };
      const agent = { name: "claude-code", email: null, kind: "agent" };
      const app = project.create({ key: "APP" }, human);
      const actions = (key) => task.activity(key).map((row) => row.action);
      const insertEvent = ({ id, created_at, entity_type = "task", entity_id = "orphan", action = "edit", changes = null }) => {
        getDb().query("INSERT INTO activity (id, created_at, actor_name, actor_email, actor_kind, entity_type, entity_id, action, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, created_at, agent.name, agent.email, agent.kind, entity_type, entity_id, action, changes == null ? null : JSON.stringify(changes));
      };
      ${script}
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("declared identity round-trips through mutations and every activity read", () => {
  runActivityCheck(`
    const declaredActor = {
      name: null, email: null, kind: "agent", source: " adapter/custom ",
      sessionId: " Conversation/1 ", threadId: " Child/2 ", agent: " Explore ",
      model: " provider/model@revision ", effort: " 0.7 ",
    };
    const expected = {
      actor_name: null, actor_email: null, actor_kind: "agent", actor_source: "adapter/custom",
      actor_session_id: "Conversation/1", actor_thread_id: "Child/2", actor_agent: "Explore",
      actor_model: "provider/model@revision", actor_effort: "0.7",
    };
    const assertIdentity = (event) => {
      for (const [field, value] of Object.entries(expected)) {
        assert.equal(event[field], value, field);
      }
    };
    const projectWithIdentity = project.create({ key: "IDENTITY" }, declaredActor);
    column.create({ projectKey: "IDENTITY", name: "Extra" }, declaredActor);
    label.create({ name: "Identity label" }, declaredActor);
    const item = task.create({ project_id: projectWithIdentity.id, title: "Attributed" }, declaredActor);
    const other = task.create({ project_id: projectWithIdentity.id, title: "Related" }, declaredActor);
    comment.create({ taskKey: item.key, text: "Context" }, declaredActor);
    relation.create({ sourceTaskKey: item.key, targetTaskKey: other.key, relation_type: "related" }, declaredActor);
    task.edit({ taskKey: item.key, title: "Changed" }, declaredActor);
    for (const event of activity.getAll().filter(event => event.actor_source !== null)) {
      assertIdentity(event);
      assertIdentity(activity.getById(event.id));
    }
    assert.deepEqual(new Set(activity.getAll().filter(event => event.actor_source !== null).map(event => event.entity_type)),
      new Set(["project", "column", "label", "task"]));
    for (const event of task.activity(item.key)) {
      assertIdentity(event);
    }
    for (const event of activity.getAll({ taskKey: item.key })) {
      assertIdentity(event);
    }

    const beforeNoOp = activity.getAll();
    task.edit({ taskKey: item.key, title: "Changed" }, declaredActor);
    assert.deepEqual(activity.getAll(), beforeNoOp);
    getDb().exec("CREATE TRIGGER fail_identity BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'activity failed'); END");
    assert.throws(() => task.edit({ taskKey: item.key, title: "Refused" }, declaredActor));
    assert.equal(task.getByKey(item.key).title, "Changed");
    assert.deepEqual(activity.getAll(), beforeNoOp);
  `);
});

test("omitted and explicit null identity declarations read as null", () => {
  runActivityCheck(`
    const omitted = task.create({ project_id: app.id, title: "Omitted" }, human);
    const explicitNull = task.create({ project_id: app.id, title: "Null" }, {
      ...agent, source: null, sessionId: null, threadId: null, agent: null, model: null, effort: null,
    });
    for (const item of [omitted, explicitNull]) {
      const [event] = task.activity(item.key);
      for (const field of ["actor_source", "actor_session_id", "actor_thread_id", "actor_agent", "actor_model", "actor_effort"]) {
        assert.equal(event[field], null, field);
      }
    }
    const before = activity.getAll();
    assert.throws(() => task.create({ project_id: app.id, title: "Invalid" }, { ...agent, model: " " }));
    assert.deepEqual(activity.getAll(), before);
    assert.equal(task.getAll({ projectKey: "APP" }).length, 2);
  `);
});

test("creation IDs and activity order stay increasing within one millisecond", () => {
  runActivityCheck(`
    const now = Date.now();
    Date.now = () => now;
    const createdProject = project.create({ key: "UUID" }, human);
    const defaultColumns = column.getAllByProjectKey(createdProject.key);
    const extraColumn = column.create({ projectKey: createdProject.key, name: "Extra" }, human);
    const createdLabel = label.create({ name: "UUID label" }, human);
    const firstTask = task.create({ project_id: createdProject.id, title: "First" }, human);
    const secondTask = task.create({ project_id: createdProject.id, title: "Second" }, human);
    const firstComment = comment.create({ taskKey: firstTask.key, text: "First comment" }, human);
    const secondComment = comment.create({ taskKey: firstTask.key, text: "Second comment" }, human);
    const createdRelation = relation.create({
      sourceTaskKey: secondTask.key,
      targetTaskKey: firstTask.key,
      relation_type: "related",
    }, human);
    const createdIds = [
      createdProject.id, ...defaultColumns.map(entry => entry.id), extraColumn.id,
      createdLabel.id, firstTask.id, secondTask.id, firstComment.id, secondComment.id,
      createdRelation.id,
    ];
    const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const id of createdIds) {
      assert.match(id, uuidV7Pattern);
    }
    assert.equal(new Set(createdIds).size, createdIds.length);
    assert.deepEqual(createdIds, [...createdIds].sort());
    assert.equal(firstComment.created_at, now);
    assert.equal(firstComment.updated_at, now);
    assert.equal(createdRelation.source_task_id, firstTask.id);
    assert.equal(createdRelation.target_task_id, secondTask.id);

    const history = task.activity(firstTask.key);
    assert.deepEqual(history.map(entry => entry.action), [
      "create", "comment_create", "comment_create", "relation_create",
    ]);
    assert.ok(history.every(entry => entry.created_at === now));
    const historyIds = history.map(entry => entry.id);
    for (const id of historyIds) {
      assert.match(id, uuidV7Pattern);
    }
    assert.equal(new Set(historyIds).size, historyIds.length);
    assert.deepEqual(activity.getAll({ taskKey: firstTask.key }).map(entry => entry.id),
      [...historyIds].reverse());
  `);
});

test("activity reads use global UUID prefix matching and distinct lookup errors", () => {
  runActivityCheck(`
    const first = "11111111-1111-7111-8111-111111111111";
    const second = "11111111-2111-7111-8111-111111111111";
    insertEvent({ id: first, created_at: 1 });
    insertEvent({ id: second, created_at: 2, entity_type: "project" });
    assert.equal(activity.getById(first).id, first);
    assert.equal(activity.getById(first.toUpperCase()).id, first);
    assert.equal(activity.getById(first.replaceAll("-", "")).id, first);
    assert.equal(activity.getById("11111111-1").id, first);
    assert.equal(activity.getById("111111111").id, first);
    assert.throws(() => activity.getById("11111111"), (error) => {
      assert.match(error.message, /ambiguous/);
      assert.ok(error.message.includes(first));
      assert.ok(error.message.includes(second));
      assert.match(error.message, /more characters/);
      return true;
    });
    assert.throws(() => activity.getById("1111111"), /at least 8/);
    assert.throws(() => activity.getById("1111-1111"), /Invalid activity ID/);
    assert.throws(() => activity.getById("ffffffff"), /No activity matches/);
    assert.ok(activity.getIds().includes(second));
  `);
});

test("activity lists order by time then ID and apply limits after task filtering", () => {
  runActivityCheck(`
    const item = task.create({ project_id: app.id, title: "Item" }, human);
    const other = task.create({ project_id: app.id, title: "Other" }, human);
    const earlier = "11111111-1111-7111-8111-111111111111";
    const tiedLower = "11111111-2111-7111-8111-111111111111";
    const tiedHigher = "11111111-3111-7111-8111-111111111111";
    const outside = "11111111-4111-7111-8111-111111111111";
    const futureTime = Date.now() + 10000;
    insertEvent({ id: earlier, created_at: futureTime, entity_id: item.id });
    insertEvent({ id: tiedHigher, created_at: futureTime + 1, entity_id: item.id });
    insertEvent({ id: tiedLower, created_at: futureTime + 1, entity_id: item.id });
    insertEvent({ id: outside, created_at: futureTime + 2, entity_id: other.id });
    const before = getDb().query("SELECT * FROM activity ORDER BY id").all();
    const changesBefore = getDb().query("SELECT total_changes() AS count").get().count;
    assert.deepEqual(activity.getAll({ limit: 4 }).map((event) => event.id), [outside, tiedHigher, tiedLower, earlier]);
    assert.deepEqual(activity.getAll({ taskKey: "app-1", limit: 2 }).map((event) => event.id), [tiedHigher, tiedLower]);
    assert.equal(activity.getAll({ taskKey: "APP-1" }).length, 4);
    assert.throws(() => activity.getById("11111111"), /ambiguous/);
    assert.deepEqual(activity.getIds().sort(), before.map((event) => event.id).sort());
    assert.deepEqual(getDb().query("SELECT * FROM activity ORDER BY id").all(), before);
    assert.equal(getDb().query("SELECT total_changes() AS count").get().count, changesBefore);
    // The existing per-task read keeps its ID-ascending contract.
    assert.deepEqual(task.activity(item.key).map((event) => event.id), before.filter((event) => event.entity_id === item.id).map((event) => event.id));
  `);
});

test("activity identity filters match complete case-sensitive values conjunctively", () => {
  runActivityCheck(`
    const conversation = { ...agent, sessionId: "conversation/one" };
    const firstThread = task.create({ project_id: app.id, title: "First thread" }, {
      ...conversation, threadId: "thread/one",
    });
    const secondThread = task.create({ project_id: app.id, title: "Second thread" }, {
      ...conversation, threadId: "thread/two",
    });
    const otherConversation = task.create({ project_id: app.id, title: "Other conversation" }, {
      ...agent, sessionId: "conversation/two", threadId: "thread/one",
    });
    const legacy = task.create({ project_id: app.id, title: "Legacy metadata" }, human);
    const firstEvent = activity.getAll().find((event) => event.entity_id === firstThread.id);
    const secondEvent = activity.getAll().find((event) => event.entity_id === secondThread.id);
    const otherEvent = activity.getAll().find((event) => event.entity_id === otherConversation.id);
    const legacyEvent = activity.getAll().find((event) => event.entity_id === legacy.id);
    const beforeRows = getDb().query("SELECT * FROM activity ORDER BY id").all();
    const changesBefore = getDb().query("SELECT total_changes() AS count").get().count;

    assert.deepEqual(activity.getAll({ sessionId: "conversation/one" }).map((event) => event.id).sort(),
      [firstEvent.id, secondEvent.id].sort());
    assert.deepEqual(activity.getAll({ threadId: "thread/one" }).map((event) => event.id).sort(),
      [firstEvent.id, otherEvent.id].sort());
    assert.deepEqual(activity.getAll({ sessionId: "conversation/one", threadId: "thread/two" }).map((event) => event.id),
      [secondEvent.id]);
    assert.deepEqual(activity.getAll({ sessionId: "conversation/two", threadId: "thread/two" }), []);
    assert.deepEqual(activity.getAll({ sessionId: "Conversation/one" }), []);
    assert.deepEqual(activity.getAll({ sessionId: "conversation/one-extra" }), []);
    assert.deepEqual(activity.getAll({ threadId: "thread/one-extra" }), []);
    assert.deepEqual(activity.getAll({ sessionId: "conversation/one", limit: 1 }).map((event) => event.id),
      [secondEvent.id]);
    assert.equal(legacyEvent.actor_session_id, null);
    assert.equal(legacyEvent.actor_thread_id, null);
    assert.deepEqual(getDb().query("SELECT * FROM activity ORDER BY id").all(), beforeRows);
    assert.equal(getDb().query("SELECT total_changes() AS count").get().count, changesBefore);
  `);
});

test("identity filters include deleted and reused task-key lifetimes and project deletion", () => {
  runActivityCheck(`
    const runActor = { ...agent, sessionId: "run/one", threadId: "thread/one" };
    const firstProject = project.create({ key: "RUN" }, runActor);
    const firstTask = task.create({ project_id: firstProject.id, title: "First lifetime" }, runActor);
    const unrelated = task.create({ project_id: firstProject.id, title: "Unrelated" }, {
      ...runActor, threadId: "thread/other",
    });
    const firstTaskCreate = activity.getAll().find((event) => event.entity_id === firstTask.id);
    const unrelatedCreate = activity.getAll().find((event) => event.entity_id === unrelated.id);

    project.delete("RUN", runActor);
    const aggregateDeletion = activity.getAll().find((event) => event.entity_type === "project" && event.action === "delete");
    const secondProject = project.create({ key: "RUN" }, runActor);
    const secondTask = task.create({ project_id: secondProject.id, title: "Second lifetime" }, runActor);
    const secondTaskCreate = activity.getAll().find((event) => event.entity_id === secondTask.id);
    const beforeRows = getDb().query("SELECT * FROM activity ORDER BY id").all();
    const changesBefore = getDb().query("SELECT total_changes() AS count").get().count;

    const filtered = activity.getAll({
      sessionId: "run/one", threadId: "thread/one", taskKey: "RUN-1",
    });
    assert.deepEqual(filtered.map((event) => event.id), [secondTaskCreate.id, aggregateDeletion.id, firstTaskCreate.id]);
    assert.equal(filtered.filter((event) => event.entity_type === "task").length, 2);
    assert.equal(filtered.filter((event) => event.entity_type === "project" && event.action === "delete").length, 1);
    assert.ok(!filtered.some((event) => event.id === unrelatedCreate.id));
    assert.deepEqual(activity.getAll({
      sessionId: "run/one", threadId: "thread/other", taskKey: "RUN-1",
    }), []);
    assert.deepEqual(getDb().query("SELECT * FROM activity ORDER BY id").all(), beforeRows);
    assert.equal(getDb().query("SELECT total_changes() AS count").get().count, changesBefore);
  `);
});

test("activity finds archived and explicitly deleted tasks without requiring a live entity", () => {
  runActivityCheck(`
    const item = task.create({ project_id: app.id, title: "Keep history" }, human);
    task.archive(item.key, agent);
    assert.equal(activity.getTaskIdentities("app-1")[0].status, "archived");
    assert.deepEqual(activity.getAll({ taskKey: item.key }).map((event) => event.action).sort(), ["archive", "create"]);
    task.delete(item.key, agent);
    assert.deepEqual(activity.getTaskIdentities(item.key), [{ id: item.id, key: item.key, title: item.title, status: "deleted" }]);
    assert.deepEqual(activity.getAll({ taskKey: item.key }).map((event) => event.action).sort(), ["archive", "create", "delete"]);
    project.delete("APP", human);
    assert.equal(activity.getAll({ taskKey: item.key }).length, 3);
    assert.deepEqual(activity.getAll({ taskKey: "APP-99" }), []);
    assert.deepEqual(activity.getTaskIdentities("UNKNOWN-1"), []);
    assert.throws(() => activity.getAll({ taskKey: "APP-0" }), /Invalid task key/);
  `);
});

test("task history includes the original aggregate project deletion and every reused-key lifetime", () => {
  runActivityCheck(`
    const first = task.create({ project_id: app.id, title: "First lifetime" }, human);
    const unrelated = task.create({ project_id: app.id, title: "Other task" }, human);
    task.archive(first.key, agent);
    const firstHistory = task.activity(first.key);
    project.delete("APP", agent);
    const deletion = activity.getAll().find((event) => event.entity_type === "project" && event.action === "delete");
    const recreatedProject = project.create({ key: "APP" }, human);
    const second = task.create({ project_id: recreatedProject.id, title: "Second lifetime" }, human);
    const all = activity.getAll({ taskKey: "APP-1" });
    assert.equal(all.length, firstHistory.length + 2);
    assert.equal(all.filter((event) => event.id === deletion.id).length, 1);
    assert.deepEqual(all.find((event) => event.id === deletion.id), deletion);
    assert.ok(!all.some((event) => event.entity_id === unrelated.id));
    assert.deepEqual(new Set(all.filter((event) => event.entity_type === "task").map((event) => event.entity_id)), new Set([first.id, second.id]));
    assert.deepEqual(activity.getTaskIdentities("app-1"), [
      { id: second.id, key: second.key, title: second.title, status: "active" },
      { id: first.id, key: first.key, title: first.title, status: "deleted" },
    ]);
    assert.deepEqual(activity.getAll({ taskKey: "APP-1", limit: 1 }), all.slice(0, 1));
    assert.equal(activity.getTaskIdentities("APP-1").length, 2);
    project.delete("APP", human);
    assert.equal(activity.getTaskIdentities("APP-1").length, 2);
    assert.equal(activity.getAll({ taskKey: "APP-1" }).filter((event) => event.entity_type === "project").length, 2);
  `);
});

test("deletion snapshots alone recover task identities and preserve the recorded event", () => {
  runActivityCheck(`
    const explicit = "22222222-1111-7111-8111-111111111111";
    const aggregate = "22222222-2111-7111-8111-111111111111";
    insertEvent({ id: explicit, created_at: 1, entity_id: "old-task", action: "delete", changes: { key: "GONE-1", title: "Deleted before other logging" } });
    insertEvent({ id: aggregate, created_at: 2, entity_type: "project", entity_id: "old-project", action: "delete", changes: { key: "GONE", tasks: [
      { id: "cascaded-task", key: "GONE-1", title: "Another lifetime" },
      { id: "cascaded-task", key: "GONE-1", title: "Another lifetime" },
    ] } });
    const events = activity.getAll({ taskKey: "gone-1" });
    assert.deepEqual(events.map((event) => event.id), [aggregate, explicit]);
    assert.deepEqual(events[0], activity.getById(aggregate));
    assert.equal(events[0].entity_id, "old-project");
    assert.equal(activity.getTaskIdentities("GONE-1").length, 2);
  `);
});

test("activity preserves every action, relation pair, null and unknown payload fields", () => {
  runActivityCheck(`
    const first = task.create({ project_id: app.id, title: "First", description: "  First line\\nSecond line  " }, human);
    const second = task.create({ project_id: app.id, title: "Second" }, human);
    relation.create({ sourceTaskKey: first.key, targetTaskKey: second.key, relation_type: "related" }, agent);
    task.order({ taskKey: second.key, direction: "top" }, agent);
    column.create({ projectKey: "APP", name: "Extra" }, human);
    label.create({ name: "Read test" }, human);
    const unknownId = "33333333-1111-7111-8111-111111111111";
    const changes = { future_field: { text: "  Preserve\\n\\tthis  ", values: [null, 3] }, title: ["First", "Renamed"] };
    insertEvent({ id: unknownId, created_at: 1, entity_id: first.id, changes });
    const all = activity.getAll();
    assert.deepEqual(new Set(all.map((event) => event.entity_type)), new Set(["task", "project", "column", "label"]));
    assert.equal(all.filter((event) => event.action === "relation_create").length, 2);
    assert.equal(all.filter((event) => event.action === "order").length, 1);
    assert.equal(all.find((event) => event.action === "order").changes, null);
    const event = activity.getById(unknownId);
    assert.deepEqual(event.changes, changes);
    assert.deepEqual(activity.getAll({ taskKey: first.key }).find((item) => item.id === unknownId), event);
    assert.deepEqual(Object.keys(event).sort(), ["id", "created_at", "actor_name", "actor_email", "actor_kind", "actor_source", "actor_session_id", "actor_thread_id", "actor_agent", "actor_model", "actor_effort", "entity_type", "entity_id", "action", "changes"].sort());
    assert.equal(all.find((event) => event.entity_id === first.id && event.action === "create").changes.description, "  First line\\nSecond line  ");
  `);
});

test.each([0, 9])("activity reads obey the existing read-only policy at schema version %i", (version) => {
  const reader = `
    import { strict as assert } from "node:assert";
    import { activity, configureDatabase, task, ReadOnlyDatabaseError } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
    import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
    configureDatabase({ client: "test", version: "0.0.0", executable: "activity-test", release: "source", allowsLegacyRead: true });
    const all = activity.getAll();
    assert.equal(all.length, 2);
    assert.deepEqual(activity.getById(all[0].id), all[0]);
    assert.equal(activity.getAll({ taskKey: "APP-1" }).length, 1);
    assert.equal(activity.getTaskIdentities("APP-1")[0].status, "active");
    assert.equal(activity.getIds().length, 2);
    assert.equal(getDb().query("PRAGMA query_only").get().query_only, 1);
    assert.equal(getDb().query("SELECT total_changes() AS count").get().count, 0);
    assert.throws(() => task.edit({ taskKey: "APP-1", title: "Refused" }, { name: "Test", kind: "human", email: null }), ReadOnlyDatabaseError);
  `;
  runActivityCheck(`
    task.create({ project_id: app.id, title: "Readable" }, human);
    getDb().exec("PRAGMA user_version = ${version}");
    const before = getDb().query("SELECT * FROM activity ORDER BY id").all();
    const result = Bun.spawnSync([process.execPath, "--eval", ${JSON.stringify(reader)}], { env: { ...process.env, ZINN_DIR: process.env.ZINN_DIR } });
    assert.equal(result.stderr.toString(), "");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(getDb().query("SELECT * FROM activity ORDER BY id").all(), before);
    assert.equal(getDb().query("PRAGMA user_version").get().user_version, ${version});
  `);
});

test("descriptions normalize before persistence and activity across projects, tasks and labels", () => {
  runActivityCheck(`
    const entities = [
      {
        type: "project",
        create: (description, index) => project.create({ key: "DESC" + index, description }, human),
        edit: (entity, changes) => project.edit({ projectKey: entity.key, ...changes }, human),
        rename: { name: "Renamed" },
      },
      {
        type: "task",
        create: (description, index) => task.create({ project_id: app.id, title: "Task " + index, description }, human),
        edit: (entity, changes) => task.edit({ taskKey: entity.key, ...changes }, human),
        rename: { title: "Renamed" },
      },
      {
        type: "label",
        create: (description, index) => label.create({ name: "label-" + index, description }, human),
        edit: (entity, changes) => label.edit({ labelName: entity.name, ...changes }, human),
        rename: { color: "red" },
      },
    ];

    for (const entity of entities) {
      const descriptions = [
        { description: undefined, expectedDescription: null },
        { description: "", expectedDescription: null },
        { description: null, expectedDescription: null },
        { description: " \\n\\t ", expectedDescription: null },
        { description: "  Context\\nMore text  ", expectedDescription: "  Context\\nMore text  " },
        { description: "\\tFirst\\n\\tSecond\\n", expectedDescription: "\\tFirst\\n\\tSecond\\n" },
      ];
      for (const [index, { description, expectedDescription }] of descriptions.entries()) {
        const created = entity.create(description, index);
        const read = () => getDb().query("SELECT * FROM " + entity.type + " WHERE id = ?").get(created.id);
        const history = () => dbActivity.getAllByEntity(entity.type, created.id);
        assert.equal(created.description, expectedDescription);
        assert.equal(read().description, expectedDescription);
        assert.equal(history()[0].changes.description, expectedDescription);

        const renamed = entity.edit(created, entity.rename);
        assert.equal(renamed.description, expectedDescription);
        assert.equal(read().description, expectedDescription);

        const clearInput = ["", null, " \\n\\t "][index % 3];
        const beforeClear = history();
        const cleared = entity.edit(renamed, { description: clearInput });
        assert.equal(cleared.description, null);
        assert.equal(read().description, null);
        if (expectedDescription === null) {
          assert.deepEqual(history(), beforeClear);
          assert.deepEqual(cleared, renamed);
        } else {
          assert.equal(history().length, beforeClear.length + 1);
          assert.deepEqual(history().at(-1).changes, { description: [expectedDescription, null] });
        }

        const beforeNoOps = history();
        const beforeRow = read();
        for (const description of ["", null, " \\n\\t "]) {
          assert.deepEqual(entity.edit(cleared, { description }), cleared);
        }
        assert.deepEqual(read(), beforeRow);
        assert.deepEqual(history(), beforeNoOps);
      }
    }
  `);
});

test("clearing a task description removes its search terms and stores null in the index", () => {
  runActivityCheck(`
    const created = task.create({ project_id: app.id, title: "Searchable", description: "descriptionneedle" }, human);
    assert.deepEqual(task.search({ query: "descriptionneedle" }).tasks.map((row) => row.key), [created.key]);
    task.edit({ taskKey: created.key, description: " \\n\\t " }, human);
    assert.deepEqual(task.search({ query: "descriptionneedle" }).tasks, []);
    assert.equal(task.search({ query: "Searchable" }).tasks[0].description, null);
    assert.equal(getDb().query("SELECT description FROM task_search WHERE task_id = ?").get(created.id).description, null);
  `);
});

test("each task mutation records one row with its actor and changes", () => {
  runActivityCheck(`
    label.create({ name: "bug" }, human);
    label.create({ name: "docs" }, human);
    const created = task.create({ project_id: app.id, title: "First", description: "old", labelNames: ["bug"] }, human);
    const [createRow] = task.activity("APP-1");
    assert.equal(createRow.action, "create");
    assert.equal(createRow.entity_type, "task");
    assert.equal(createRow.entity_id, created.id);
    assert.equal(createRow.actor_name, "Test Human");
    assert.equal(createRow.actor_email, "human@example.com");
    assert.equal(createRow.actor_kind, "human");
    assert.equal(createRow.created_at, created.updated_at);
    assert.equal(createRow.changes.title, "First");
    assert.equal(createRow.changes.column.name, "Backlog");
    assert.deepEqual(createRow.changes.labels, ["bug"]);

    const edited = task.edit({ taskKey: "APP-1", title: "Renamed", description: "new", priority: "high", addLabelNames: ["docs"], removeLabelNames: ["bug"] }, agent);
    const editRow = task.activity("APP-1").at(-1);
    assert.equal(editRow.action, "edit");
    assert.equal(editRow.actor_kind, "agent");
    assert.equal(editRow.actor_email, null);
    assert.equal(editRow.created_at, edited.updated_at);
    assert.deepEqual(editRow.changes, {
      title: ["First", "Renamed"],
      description: ["old", "new"],
      priority: [null, "high"],
      labels: { added: ["docs"], removed: ["bug"] },
    });

    task.edit({ taskKey: "APP-1", priority: null }, agent);
    assert.deepEqual(task.activity("APP-1").at(-1).changes, { priority: ["high", null] });
    task.label.add({ taskKey: "APP-1", labelNames: ["bug"] }, agent);
    assert.deepEqual(task.activity("APP-1").at(-1).changes, { labels: { added: ["bug"], removed: [] } });

    const moved = task.move({ taskKey: "APP-1", targetColumn: "in progress" }, agent);
    const moveRow = task.activity("APP-1").at(-1);
    assert.equal(moveRow.created_at, moved.updated_at);
    assert.deepEqual(moveRow.changes.column.map((column) => column.name), ["Backlog", "In Progress"]);
    assert.equal(moveRow.changes.column[1].id, moved.column_id);

    task.create({ project_id: app.id, title: "Second", description: null }, human);
    task.move({ taskKey: "APP-2", targetColumn: "In Progress" }, human);
    task.order({ taskKey: "APP-2", direction: "top" }, human);
    assert.equal(task.activity("APP-2").at(-1).action, "order");
    assert.equal(task.activity("APP-2").at(-1).changes, null);

    task.archive("APP-1", human);
    task.unarchive("APP-1", human);
    assert.deepEqual(actions("APP-1"), ["create", "edit", "edit", "edit", "move", "archive", "unarchive"]);
  `);
});

test("no-op mutations record nothing", () => {
  runActivityCheck(`
    label.create({ name: "bug" }, human);
    label.create({ name: "docs" }, human);
    task.create({ project_id: app.id, title: "Only", description: null, labelNames: ["bug"] }, human);
    task.edit({ taskKey: "APP-1", title: "Only" }, human);
    task.label.add({ taskKey: "APP-1", labelNames: ["bug"] }, human);
    task.label.remove({ taskKey: "APP-1", labelNames: ["docs"] }, human);
    task.move({ taskKey: "APP-1", targetColumn: "Backlog" }, human);
    task.order({ taskKey: "APP-1", direction: "top" }, human);
    task.unarchive("APP-1", human);
    task.archive("APP-1", human);
    task.archive("APP-1", human);
    assert.deepEqual(actions("APP-1"), ["create", "archive"]);
  `);
});

test("failed mutations leave no activity behind", () => {
  runActivityCheck(`
    task.create({ project_id: app.id, title: "Only", description: null }, human);
    const later = column.create({ projectKey: "APP", name: "Later" }, human);
    const bug = label.create({ name: "bug" }, human);
    const db = getDb();
    db.exec("CREATE TRIGGER fail_activity BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'activity failed'); END");
    assert.throws(() => project.create({ key: "OTHER" }, human), /activity failed/);
    assert.equal(project.getByKey("OTHER"), null);
    assert.throws(() => label.create({ name: "docs" }, human), /activity failed/);
    assert.equal(label.getByName("docs") == null, true);
    db.exec("DROP TRIGGER fail_activity");

    db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON task BEGIN SELECT RAISE(ABORT, 'update failed'); END");
    assert.throws(() => task.edit({ taskKey: "APP-1", title: "Nope" }, human), /update failed/);
    assert.throws(() => task.move({ taskKey: "APP-1", targetColumn: "Done" }, human), /update failed/);
    assert.throws(() => task.archive("APP-1", human), /update failed/);
    db.exec("DROP TRIGGER fail_update");
    assert.throws(() => task.edit({ taskKey: "APP-1", addLabelNames: ["missing"] }, human), /does not exist/);
    assert.deepEqual(actions("APP-1"), ["create"]);

    db.exec("CREATE TRIGGER fail_project_update BEFORE UPDATE ON project BEGIN SELECT RAISE(ABORT, 'project update failed'); END");
    assert.throws(() => project.edit({ projectKey: "APP", name: "Nope" }, human), /project update failed/);
    db.exec("DROP TRIGGER fail_project_update");
    assert.deepEqual(dbActivity.getAllByEntity("project", app.id).map((row) => row.action), ["create"]);

    db.exec("CREATE TRIGGER fail_column_update BEFORE UPDATE ON project_column BEGIN SELECT RAISE(ABORT, 'column update failed'); END");
    assert.throws(() => column.edit({ projectKey: "APP", columnName: "Later", name: "Nope" }, human), /column update failed/);
    db.exec("DROP TRIGGER fail_column_update");
    assert.deepEqual(dbActivity.getAllByEntity("column", later.id).map((row) => row.action), ["create"]);

    db.exec("CREATE TRIGGER fail_label_update BEFORE UPDATE ON label BEGIN SELECT RAISE(ABORT, 'label update failed'); END");
    assert.throws(() => label.edit({ labelName: "bug", name: "Nope" }, human), /label update failed/);
    db.exec("DROP TRIGGER fail_label_update");
    assert.deepEqual(dbActivity.getAllByEntity("label", bug.id).map((row) => row.action), ["create"]);

    db.exec("CREATE TRIGGER fail_project_delete BEFORE DELETE ON project BEGIN SELECT RAISE(ABORT, 'project delete failed'); END");
    assert.throws(() => project.delete("APP", human), /project delete failed/);
    db.exec("DROP TRIGGER fail_project_delete");
    assert.equal(project.getById(app.id).key, "APP");
    assert.deepEqual(dbActivity.getAllByEntity("project", app.id).map((row) => row.action), ["create"]);
  `);
});

test("core requires a valid actor and never defaults one", () => {
  runActivityCheck(`
    assert.throws(() => project.create({ key: "NOACTOR" }), /actor is required/);
    assert.equal(project.getByKey("NOACTOR"), null);
    assert.throws(() => project.edit({ projectKey: "APP", name: "No actor" }), /actor is required/);
    assert.throws(() => column.create({ projectKey: "APP", name: "No actor" }), /actor is required/);
    assert.throws(() => label.create({ name: "no-actor" }), /actor is required/);
    assert.throws(() => task.create({ project_id: app.id, title: "No actor", description: null }), /actor is required/);
    assert.throws(() => task.create({ project_id: app.id, title: "Blank", description: null }, { ...human, name: "  " }), /Actor name cannot be blank/);
    assert.throws(() => task.create({ project_id: app.id, title: "Robot", description: null }, { ...human, kind: "robot" }));
    assert.equal(task.getAll().length, 0);
    task.create({ project_id: app.id, title: "Trimmed", description: null }, { ...human, name: "  Padded  " });
    assert.equal(task.activity("APP-1")[0].actor_name, "Padded");
    assert.throws(() => task.move({ taskKey: "APP-1", targetColumn: "Done" }), /actor is required/);
    assert.deepEqual(actions("APP-1"), ["create"]);
  `);
});

test("relations record the same row on both tasks, and deletions cascade to survivors", () => {
  runActivityCheck(`
    const first = task.create({ project_id: app.id, title: "First", description: null }, human);
    const second = task.create({ project_id: app.id, title: "Second", description: null }, human);
    const third = task.create({ project_id: app.id, title: "Third", description: null }, human);
    const dependency = relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "dependency" }, agent);
    const firstRow = task.activity("APP-1").at(-1);
    const secondRow = task.activity("APP-2").at(-1);
    assert.equal(firstRow.action, "relation_create");
    assert.deepEqual(firstRow.changes, secondRow.changes);
    assert.equal(firstRow.created_at, dependency.created_at);
    assert.deepEqual(firstRow.changes, {
      type: "dependency",
      source: { id: first.id, key: "APP-1" },
      target: { id: second.id, key: "APP-2" },
    });

    relation.create({ sourceTaskKey: "APP-3", targetTaskKey: "APP-1", relation_type: "related" }, agent);
    relation.delete({ sourceTaskKey: "APP-1", targetTaskKey: "APP-3", relation_type: "related" }, agent);
    assert.deepEqual(actions("APP-3"), ["create", "relation_create", "relation_delete"]);
    assert.equal(task.activity("APP-1").at(-1).action, "relation_delete");

    task.delete("APP-2", human);
    assert.deepEqual(actions("APP-1"), ["create", "relation_create", "relation_create", "relation_delete", "relation_delete"]);
    assert.equal(task.activity("APP-1").at(-1).changes.target.key, "APP-2");
    const deletedHistory = dbActivity.getAllByEntity("task", second.id);
    assert.deepEqual(deletedHistory.map((row) => row.action), ["create", "relation_create", "delete"]);
    assert.deepEqual(deletedHistory.at(-1).changes, { key: "APP-2", title: "Second" });
    assert.deepEqual(actions("APP-3"), ["create", "relation_create", "relation_delete"]);
  `);
});

test("deleting a label definition records an edit on each task that had it", () => {
  runActivityCheck(`
    label.create({ name: "bug" }, human);
    task.create({ project_id: app.id, title: "Tagged", description: null, labelNames: ["bug"] }, human);
    task.create({ project_id: app.id, title: "Untagged", description: null }, human);
    label.delete({ name: "bug" }, agent);
    const row = task.activity("APP-1").at(-1);
    assert.equal(row.action, "edit");
    assert.equal(row.actor_name, "claude-code");
    assert.equal(row.created_at, task.getByKey("APP-1").updated_at);
    assert.deepEqual(row.changes, { labels: { added: [], removed: ["bug"] } });
    assert.deepEqual(actions("APP-2"), ["create"]);
  `);
});

test("project, column, and label definition mutations record their own activity", () => {
  runActivityCheck(`
    const initialProjectActivity = dbActivity.getAllByEntity("project", app.id);
    assert.equal(initialProjectActivity.length, 1);
    assert.equal(initialProjectActivity[0].action, "create");
    assert.deepEqual(initialProjectActivity[0].changes, {
      key: "APP",
      name: "APP",
      description: null,
      columns: column.getAllByProjectKey("APP").map(({ id, name }) => ({ id, name })),
    });

    project.edit({ projectKey: "APP", name: "Application" }, human);
    project.edit({ projectKey: "APP", name: "Application" }, agent);
    assert.deepEqual(
      dbActivity.getAllByEntity("project", app.id).map((row) => row.action),
      ["create", "edit"],
    );
    assert.deepEqual(dbActivity.getAllByEntity("project", app.id).at(-1).changes, {
      name: ["APP", "Application"],
    });

    const createdColumn = column.create({ projectKey: "APP", name: "Later" }, agent);
    column.edit({ projectKey: "APP", columnName: "Later", name: "Someday" }, human);
    column.edit({ projectKey: "APP", columnName: "Someday", name: "Someday" }, agent);
    column.order({ projectKey: "APP", columnName: "Someday", direction: "first" }, agent);
    column.order({ projectKey: "APP", columnName: "Someday", direction: "first" }, human);
    const columnActivity = dbActivity.getAllByEntity("column", createdColumn.id);
    assert.deepEqual(columnActivity.map((row) => row.action), ["create", "edit", "order"]);
    assert.deepEqual(columnActivity[0].changes, {
      project: { id: app.id, key: "APP" },
      name: "Later",
    });
    assert.deepEqual(columnActivity[1].changes, { name: ["Later", "Someday"] });
    assert.equal(columnActivity[2].changes, null);

    const createdLabel = label.create({ name: "bug", description: "Broken", color: "red" }, human);
    label.edit({ labelName: "bug", name: "defect", description: "Unexpected", color: "blue" }, agent);
    label.edit({ labelName: "defect", name: "defect" }, human);
    label.delete({ name: "defect" }, agent);
    const labelActivity = dbActivity.getAllByEntity("label", createdLabel.id);
    assert.deepEqual(labelActivity.map((row) => row.action), ["create", "edit", "delete"]);
    assert.deepEqual(labelActivity[1].changes, {
      name: ["bug", "defect"],
      description: ["Broken", "Unexpected"],
      color: ["red", "blue"],
    });
    assert.deepEqual(labelActivity[2].changes, {
      name: "defect",
      description: "Unexpected",
      color: "blue",
    });
  `);
});

test("project deletion records one aggregate event with ordered columns and task snapshots", () => {
  runActivityCheck(`
    const extraColumn = column.create({ projectKey: "APP", name: "Icebox" }, human);
    column.order({ projectKey: "APP", columnName: "Icebox", direction: "first" }, human);
    const first = task.create({ project_id: app.id, title: "First", description: null }, human);
    const second = task.create({ project_id: app.id, title: "Second", description: null }, agent);
    task.archive("APP-2", agent);
    const expectedColumns = column.getAllByProjectKey("APP").map(({ id, name }) => ({ id, name }));

    project.delete("APP", human);

    const projectActivity = dbActivity.getAllByEntity("project", app.id);
    assert.deepEqual(projectActivity.map((row) => row.action), ["create", "delete"]);
    assert.deepEqual(projectActivity.at(-1).changes, {
      key: "APP",
      name: "APP",
      description: null,
      columns: expectedColumns,
      tasks: [
        { id: first.id, key: "APP-1", title: "First" },
        { id: second.id, key: "APP-2", title: "Second" },
      ],
    });
    assert.deepEqual(dbActivity.getAllByEntity("task", first.id).map((row) => row.action), ["create"]);
    assert.deepEqual(dbActivity.getAllByEntity("task", second.id).map((row) => row.action), ["create", "archive"]);
    assert.deepEqual(dbActivity.getAllByEntity("column", extraColumn.id).map((row) => row.action), ["create", "order"]);
    assert.equal(project.getById(app.id), null);
  `);
});


test("project description edits preserve omitted fields, skip no-ops and record only changes", () => {
  runActivityCheck(`
    const described = project.create({ key: "DESC", description: "Purpose\\nContext" }, human);
    assert.equal(described.description, "Purpose\\nContext");
    assert.equal(dbActivity.getAllByEntity("project", described.id)[0].changes.description, described.description);
    const renamed = project.edit({ projectKey: "DESC", name: "Named" }, human);
    assert.equal(renamed.description, described.description);
    const edited = project.edit({ projectKey: "DESC", description: "New" }, human);
    assert.equal(edited.name, "Named");
    assert.deepEqual(dbActivity.getAllByEntity("project", described.id).at(-1).changes, { description: [described.description, "New"] });
    const before = dbActivity.getAllByEntity("project", described.id);
    assert.deepEqual(project.edit({ projectKey: "DESC", description: "New" }, human), edited);
    assert.deepEqual(dbActivity.getAllByEntity("project", described.id), before);
    assert.equal(project.edit({ projectKey: "DESC", description: "" }, human).description, null);
    assert.equal(project.edit({ projectKey: "DESC", description: null }, human).description, null);
    getDb().exec("CREATE TRIGGER reject_description BEFORE UPDATE ON project BEGIN SELECT RAISE(ABORT, 'rejected'); END");
    const beforeFailure = dbActivity.getAllByEntity("project", described.id);
    assert.throws(() => project.edit({ projectKey: "DESC", description: "fail" }, human), /rejected/);
    assert.deepEqual(dbActivity.getAllByEntity("project", described.id), beforeFailure);
    assert.equal(project.getByKey("DESC").description, null);
  `);
});
