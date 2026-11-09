import { expect, test } from "bun:test";

import { activity, column, project } from "../index";
import { CoreError } from "./errors";
import { withTestStore } from "./testing";

const actor = { name: "Test Human", email: null, kind: "human" as const };

function columnFacts(projectKey: string) {
  return column.getAllByProjectKey(projectKey).map(({ name, category }) => ({ name, category }));
}

function columnEvents(columnId: string) {
  return activity.getAll().events.filter((event) => event.entity_id === columnId);
}

test("a new project gets six default columns with their categories, recorded in its create activity", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const defaults = [
      { name: "Backlog", category: "backlog" },
      { name: "TODO", category: "todo" },
      { name: "Doing", category: "in_progress" },
      { name: "Review", category: "review" },
      { name: "Done", category: "done" },
      { name: "Cancelled", category: "cancelled" },
    ];

    expect(columnFacts("APP")).toEqual(defaults as never);
    const created = activity.getAll().events.find((event) => event.entity_id === app.id)!;
    expect((created.changes as { columns: Array<{ name: string; category: string }> }).columns.map(
      ({ name, category }) => ({ name, category }),
    )).toEqual(defaults);
  });
});

test("column create stores the given category and records it", () => {
  withTestStore(() => {
    project.create({ key: "APP" }, actor);
    const shipped = column.create({ projectKey: "APP", name: "Shipped", category: "done" }, actor);

    expect(shipped.category).toBe("done");
    expect(columnFacts("APP").at(-1)).toEqual({ name: "Shipped", category: "done" });
    expect(columnEvents(shipped.id)[0]!.changes).toMatchObject({ name: "Shipped", category: "done" });
  });
});

test("column create without a valid category fails and writes nothing", () => {
  withTestStore(() => {
    project.create({ key: "APP" }, actor);
    const before = columnFacts("APP");
    const eventCount = activity.getAll().events.length;

    for (const category of [undefined, "finished"]) {
      expect(() => column.create({ projectKey: "APP", name: "Shipped", category } as never, actor)).toThrow(CoreError);
    }
    expect(columnFacts("APP")).toEqual(before);
    expect(activity.getAll().events.length).toBe(eventCount);
  });
});

test("column edit changes a category, keeps it on rename, and skips no-op writes", () => {
  withTestStore(() => {
    project.create({ key: "APP" }, actor);
    const review = column.getByName("APP", "Review");

    const recategorized = column.edit({ projectKey: "APP", columnName: "review", category: "done" }, actor);
    expect(recategorized).toEqual({ column: { ...review, category: "done" }, changed: true });
    expect(columnEvents(review.id)[0]!.changes).toEqual({ category: ["review", "done"] });

    const renamed = column.edit({ projectKey: "APP", columnName: "Review", name: "Accepted" }, actor);
    expect(renamed.column).toEqual({ ...review, name: "Accepted", category: "done" });
    expect(columnEvents(review.id)[0]!.changes).toEqual({ name: ["Review", "Accepted"] });

    const both = column.edit({ projectKey: "APP", columnName: "Accepted", name: "Review", category: "review" }, actor);
    expect(both.column).toEqual(review);
    expect(columnEvents(review.id)[0]!.changes).toEqual({
      name: ["Accepted", "Review"],
      category: ["done", "review"],
    });

    const eventCount = activity.getAll().events.length;
    expect(column.edit({ projectKey: "APP", columnName: "Review", category: "review" }, actor)).toEqual({
      column: review,
      changed: false,
    });
    expect(activity.getAll().events.length).toBe(eventCount);
  });
});
