import { expect, test } from "bun:test";
import { column, project, relation, task } from "../index";
import { getDb } from "./db";
import { withTestStore } from "./testing";

const actor = { name: "Test Human", email: null, kind: "human" as const };

test("project task counts include empty projects and leave ordinary project records unchanged", () => {
  withTestStore(() => {
    getDb({ createsDatabase: true });
    expect(project.getAllWithTaskCounts()).toEqual([]);
    const empty = project.create({ key: "EMPTY" }, actor);

    expect(project.getAllWithTaskCounts()).toEqual([
      { ...empty, taskCounts: { active: 0, archived: 0 } },
    ]);
    expect(project.getAll()).toEqual([empty]);
    expect(project.getByKey("EMPTY")).toEqual(empty);
  });
});

test("project task counts follow archive and deletion state independently of columns and relations", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP", name: "App" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    const archivedOnly = project.create({ key: "OLD" }, actor);
    project.create({ key: "EMPTY" }, actor);
    column.create({ projectKey: "OTHER", name: "Custom" }, actor);

    const parent = task.create({ project_id: app.id, title: "Parent" }, actor);
    const child = task.create({ project_id: app.id, title: "Child" }, actor);
    const finished = task.create({ project_id: app.id, title: "Done but active" }, actor);
    const archived = task.create({ project_id: app.id, title: "Archived" }, actor);
    const remoteChild = task.create({ project_id: other.id, title: "Remote child" }, actor);
    const old = task.create({ project_id: archivedOnly.id, title: "Old" }, actor);
    task.move({ taskKey: finished.key, targetColumn: "Done" }, actor);
    task.move({ taskKey: remoteChild.key, targetColumn: "Custom" }, actor);
    task.archive(archived.key, actor);
    task.archive(old.key, actor);

    for (const source of [child, remoteChild]) {
      relation.create({
        sourceTaskKey: source.key,
        targetTaskKey: parent.key,
        relation_type: "subtask",
      }, actor);
    }
    relation.create({
      sourceTaskKey: child.key,
      targetTaskKey: finished.key,
      relation_type: "related",
    }, actor);

    const counts = () => Object.fromEntries(
      project.getAllWithTaskCounts().map((entry) => [entry.key, entry.taskCounts]),
    );
    expect(counts()).toEqual({
      APP: { active: 3, archived: 1 },
      OTHER: { active: 1, archived: 0 },
      OLD: { active: 0, archived: 1 },
      EMPTY: { active: 0, archived: 0 },
    });
    for (const entry of project.getAllWithTaskCounts()) {
      const detail = column.getTaskCountsByProjectKey(entry.key);
      expect(entry.taskCounts.active).toBe(detail.columns.reduce((sum, value) => sum + value.taskCount, 0));
      expect(entry.taskCounts.archived).toBe(detail.archivedTaskCount);
    }

    task.archive(finished.key, actor);
    expect(counts().APP).toEqual({ active: 2, archived: 2 });
    task.unarchive(archived.key, actor);
    expect(counts().APP).toEqual({ active: 3, archived: 1 });
    task.delete(parent.key, actor);
    expect(counts().APP).toEqual({ active: 2, archived: 1 });
    expect(counts().OTHER).toEqual({ active: 1, archived: 0 });
    task.delete(finished.key, actor);
    expect(counts().APP).toEqual({ active: 2, archived: 0 });
    expect(project.getByKey("APP")!.task_count).toBe(4);
    task.delete(old.key, actor);
    expect(counts().OLD).toEqual({ active: 0, archived: 0 });
  });
});
