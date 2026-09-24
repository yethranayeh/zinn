import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runCommentCheck(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-comments-"));

  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
          import { strict as assert } from "node:assert";
          import { comment, project, task } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
          import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
          const human = { name: "Test Human", email: "human@example.com", kind: "human" };
          const app = project.create({ key: "APP" });
          ${script}
        `,
      ],
      { env: { ...process.env, ZINN_DIR: directory } },
    );

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("comments have stable per-task keys", () => {
  runCommentCheck(`
    task.create({ project_id: app.id, title: "First", description: null }, human);
    task.create({ project_id: app.id, title: "Second", description: null }, human);
    task.archive("APP-2", human);

    const first = comment.create({ taskKey: "APP-1", text: "First comment" }, human);
    const second = comment.create({ taskKey: "app-1", text: "Second comment" }, human);
    const otherTask = comment.create({ taskKey: "APP-2", text: "Other task" }, human);

    assert.equal(first.key, "APP-1#1");
    assert.equal(second.key, "APP-1#2");
    assert.equal(otherTask.key, "APP-2#1");
    assert.equal(first.created_at, first.updated_at);
    assert.equal(comment.getByKey("app-1#1").id, first.id);
    assert.throws(() => comment.getByKey(second.id), /Invalid comment key/);
    assert.deepEqual(comment.getAll("APP-1").map((entry) => entry.key), ["APP-1#1", "APP-1#2"]);

    // Listing follows comment numbers even when storage IDs disagree.
    getDb().run("UPDATE comment SET id = '00000000-0000-7000-8000-000000000000' WHERE id = ?", [second.id]);
    assert.deepEqual(comment.getAll("APP-1").map((entry) => entry.key), ["APP-1#1", "APP-1#2"]);

    comment.delete({ commentKey: "APP-1#2" }, human);
    const third = comment.create({ taskKey: "APP-1", text: "Third comment" }, human);
    assert.equal(third.key, "APP-1#3");
    assert.throws(() => comment.getByKey("APP-1#2"), /does not exist/);
  `);
});

test("comment mutations update task activity atomically and no-op edits stay unchanged", () => {
  runCommentCheck(`
    task.create({ project_id: app.id, title: "First", description: null }, human);
    const db = getDb();
    db.run("UPDATE task SET updated_at = 1 WHERE number = 1");
    const created = comment.create({ taskKey: "APP-1", text: "Original" }, human);
    assert.equal(task.getByKey("APP-1").updated_at, 1);
    assert.deepEqual(task.activity("APP-1").at(-1).changes, {
      comment: { id: created.id, key: "APP-1#1", text: "Original" },
    });

    const activityCount = task.activity("APP-1").length;
    const unchanged = comment.edit({ commentKey: created.key, text: "Original" }, human);
    assert.equal(unchanged.updated_at, created.updated_at);
    assert.equal(task.activity("APP-1").length, activityCount);

    const edited = comment.edit({ commentKey: "APP-1#1", text: "Edited" }, human);
    assert.equal(task.getByKey("APP-1").updated_at, 1);
    assert.deepEqual(task.activity("APP-1").at(-1).changes, {
      comment: { id: created.id, key: "APP-1#1" },
      text: ["Original", "Edited"],
    });

    const deleted = comment.delete({ commentKey: edited.key }, human);
    assert.equal(deleted.key, "APP-1#1");
    assert.deepEqual(task.activity("APP-1").map((row) => row.action), [
      "create",
      "comment_create",
      "comment_edit",
      "comment_delete",
    ]);
    assert.deepEqual(task.activity("APP-1").at(-1).changes, {
      comment: { id: created.id, key: "APP-1#1", text: "Edited" },
    });
    assert.equal(task.getByKey("APP-1").updated_at, 1);

    db.run("CREATE TRIGGER fail_comment BEFORE INSERT ON comment BEGIN SELECT RAISE(ABORT, 'comment failed'); END");
    assert.throws(() => comment.create({ taskKey: "APP-1", text: "Failure" }, human), /comment failed/);
    db.run("DROP TRIGGER fail_comment");
    const afterFailure = comment.create({ taskKey: "APP-1", text: "After failure" }, human);
    assert.equal(afterFailure.key, "APP-1#2");
  `);
});

test("comments preserve text, reject blank text, and cascade with their task", () => {
  runCommentCheck(`
    task.create({ project_id: app.id, title: "First", description: null }, human);
    const text = "  Keep indentation\\n    code  ";
    const created = comment.create({ taskKey: "APP-1", text }, human);
    assert.equal(created.text, text);
    assert.throws(() => comment.create({ taskKey: "APP-1", text: "   \\n" }, human), /cannot be blank/);
    assert.throws(() => comment.edit({ commentKey: created.key, text: "\\t" }, human), /cannot be blank/);
    assert.throws(() => comment.getByKey("APP-1#0"), /Expected format PROJECT-1#1/);
    assert.throws(() => comment.getByKey("NOPE-1#0"), /Invalid comment key "NOPE-1#0"/);
    assert.throws(() => comment.getByKey("APP-1#2#3"), /Invalid comment key "APP-1#2#3"/);

    task.delete("APP-1", human);
    assert.equal(getDb().query("SELECT COUNT(*) AS count FROM comment").get().count, 0);
  `);
});
