import { expect, test } from "bun:test";
import { project, task } from "../index";
import { getDb } from "./db";
import { CoreError, InputValidationError } from "./errors";
import { withTestStore } from "./testing";

// ZINN-580: task.edit refuses the whole edit when an expected value differs from the stored one.

const human = { name: "Test Human", email: "human@example.com", kind: "human" as const };
const DUE = Date.UTC(2026, 0, 15);

function seed() {
  const app = project.create({ key: "APP" }, human);
  task.create({ project_id: app.id, title: "Title A", description: "Description A" }, human);
}

const stored = () =>
  getDb()
    .query<{ title: string; description: string | null; priority: string | null; due_at: number | null }, []>(
      "SELECT title, description, priority, due_at FROM task",
    )
    .get()!;

const editCount = () =>
  getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM activity WHERE action = 'edit'").get()!.count;

function expectValueChanged(edit: () => unknown, changedFields: Array<string>) {
  const before = { task: stored(), edits: editCount() };
  let thrown: unknown;
  try {
    edit();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(CoreError);
  const error = thrown as CoreError;
  expect(error.kind).toBe("conflict");
  expect(error.facts).toEqual({ entity: "task", key: "APP-1", reason: "value_changed", changedFields });
  expect({ task: stored(), edits: editCount() }).toEqual(before);
}

test("an expected value that differs from the stored one refuses the edit and writes nothing", () => {
  withTestStore(() => {
    seed();
    task.edit({ taskKey: "APP-1", description: "Description C" }, human);

    expectValueChanged(
      () =>
        task.edit(
          { taskKey: "APP-1", description: "Description B", expected: { description: "Description A" } },
          human,
        ),
      ["description"],
    );
    expect(stored().description).toBe("Description C");
  });
});

test("matching expected values let the edit through", () => {
  withTestStore(() => {
    seed();
    const result = task.edit(
      {
        taskKey: "APP-1",
        title: "Title B",
        description: "Description B",
        expected: { title: "Title A", description: "Description A", priority: null, due_at: null },
      },
      human,
    );

    expect(result.changed).toBe(true);
    expect(stored()).toMatchObject({ title: "Title B", description: "Description B" });
    expect(editCount()).toBe(1);
  });
});

test("a change to an unguarded field does not refuse the edit and keeps its value", () => {
  withTestStore(() => {
    seed();
    task.edit({ taskKey: "APP-1", title: "Title C" }, human);

    task.edit(
      { taskKey: "APP-1", description: "Description B", expected: { description: "Description A" } },
      human,
    );

    expect(stored()).toMatchObject({ title: "Title C", description: "Description B" });
  });
});

test("a stored value equal to the new value but not to the expected value refuses the edit", () => {
  withTestStore(() => {
    seed();
    task.edit({ taskKey: "APP-1", description: "Description B" }, human);

    expectValueChanged(
      () =>
        task.edit(
          { taskKey: "APP-1", description: "Description B", expected: { description: "Description A" } },
          human,
        ),
      ["description"],
    );
  });
});

test("one mismatch among guarded fields refuses every field, and every mismatch is named in field order", () => {
  withTestStore(() => {
    seed();
    task.edit({ taskKey: "APP-1", description: "Description C" }, human);

    expectValueChanged(
      () =>
        task.edit(
          {
            taskKey: "APP-1",
            title: "Title B",
            description: "Description B",
            expected: { title: "Title A", description: "Description A" },
          },
          human,
        ),
      ["description"],
    );

    task.edit({ taskKey: "APP-1", title: "Title C", priority: "high", due_at: DUE }, human);
    expectValueChanged(
      () =>
        task.edit(
          {
            taskKey: "APP-1",
            title: "Title B",
            expected: { due_at: null, priority: "low", description: "Description C", title: "Title A" },
          },
          human,
        ),
      ["title", "priority", "due_at"],
    );
  });
});

test("expected empty values match empty fields and refuse set ones", () => {
  withTestStore(() => {
    seed();
    task.edit({ taskKey: "APP-1", description: null }, human);
    const emptyExpectations = [{ description: null }, { description: "" }, { description: " \n" }, { priority: null }, { due_at: null }];

    for (const expected of emptyExpectations) {
      expect(task.edit({ taskKey: "APP-1", title: `Title ${editCount()}`, expected }, human).changed).toBe(true);
    }

    task.edit({ taskKey: "APP-1", description: "Set", priority: "high", due_at: DUE }, human);
    for (const [expected, field] of [
      [{ description: null }, "description"],
      [{ priority: null }, "priority"],
      [{ due_at: null }, "due_at"],
    ] as const) {
      expectValueChanged(() => task.edit({ taskKey: "APP-1", title: "Other", expected }, human), [field]);
    }
  });
});

test("partial description edits are guarded by the whole stored text, before the text is matched", () => {
  withTestStore(() => {
    seed();
    task.edit({ taskKey: "APP-1", description: "Description C" }, human);

    expectValueChanged(
      () =>
        task.edit(
          { taskKey: "APP-1", description: { append: "More" }, expected: { description: "Description A" } },
          human,
        ),
      ["description"],
    );
    // ? "missing" matches nothing, so without the guard this would fail with text_match_count.
    expectValueChanged(
      () =>
        task.edit(
          {
            taskKey: "APP-1",
            description: { find: "missing", replace: "x" },
            expected: { description: "Description A" },
          },
          human,
        ),
      ["description"],
    );

    task.edit(
      { taskKey: "APP-1", description: { find: "C", replace: "D" }, expected: { description: "Description C" } },
      human,
    );
    expect(stored().description).toBe("Description D");
  });
});

test("an expected value may guard a field the edit does not change", () => {
  withTestStore(() => {
    seed();
    task.edit({ taskKey: "APP-1", description: "Description C" }, human);

    expectValueChanged(
      () => task.edit({ taskKey: "APP-1", title: "Title B", expected: { description: "Description A" } }, human),
      ["description"],
    );
    task.edit({ taskKey: "APP-1", title: "Title B", expected: { description: "Description C" } }, human);
    expect(stored()).toMatchObject({ title: "Title B", description: "Description C" });
  });
});

test("expected values alone are not an edit", () => {
  withTestStore(() => {
    seed();
    expect(() => task.edit({ taskKey: "APP-1", expected: { title: "Title A" } }, human)).toThrow(InputValidationError);
    expect(editCount()).toBe(0);
  });
});

test("an edit without expected values still writes over a changed value", () => {
  withTestStore(() => {
    seed();
    task.edit({ taskKey: "APP-1", description: "Description C" }, human);
    task.edit({ taskKey: "APP-1", description: "Description B" }, human);

    expect(stored().description).toBe("Description B");
  });
});
