import { expect, test } from "bun:test";
import { comment, label, project, task } from "../index";
import { getDb } from "./db";
import { CoreError, InputValidationError, type FailureFacts } from "./errors";
import { withTestStore } from "./testing";

// ZINN-581: comment.edit, project.edit and label.edit refuse the whole edit when an expected value differs from the stored one.

const human = { name: "Test Human", email: "human@example.com", kind: "human" as const };

const activityCount = () =>
  getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM activity").get()!.count;

const storedComment = () => getDb().query<{ text: string }, []>("SELECT text FROM comment").get()!;

const storedProject = () =>
  getDb()
    .query<{ name: string; description: string | null }, []>("SELECT name, description FROM project")
    .get()!;

const storedLabel = () =>
  getDb()
    .query<{ name: string; description: string | null; color: string }, []>(
      "SELECT name, description, color FROM label",
    )
    .get()!;

// ? Creates APP with name "Name A" and description "Description A", task APP-1 with comment APP-1#1 "Text A",
// ? and label "bug" with description "Description A" and color red.
function seed() {
  const app = project.create({ key: "APP", name: "Name A", description: "Description A" }, human);
  task.create({ project_id: app.id, title: "Task" }, human);
  comment.create({ taskKey: "APP-1", text: "Text A" }, human);
  label.create({ name: "bug", description: "Description A", color: "red" }, human);
}

function expectValueChanged(
  edit: () => unknown,
  facts: Pick<FailureFacts, "entity" | "key" | "changedFields">,
) {
  const snapshot = () => ({
    comment: storedComment(),
    project: storedProject(),
    label: storedLabel(),
    activity: activityCount(),
  });
  const before = snapshot();
  let thrown: unknown;
  try {
    edit();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(CoreError);
  const error = thrown as CoreError;
  expect(error.kind).toBe("conflict");
  expect(error.facts).toEqual({ ...facts, reason: "value_changed" });
  expect(snapshot()).toEqual(before);
}

const commentConflict = { entity: "comment" as const, key: "APP-1#1", changedFields: ["text"] };
const projectConflict = (changedFields: Array<string>) => ({ entity: "project" as const, key: "APP", changedFields });
const labelConflict = (changedFields: Array<string>) => ({ entity: "label" as const, key: "bug", changedFields });

test("comment edits: a stale expected text refuses the edit, also when the stored text equals the new one", () => {
  withTestStore(() => {
    seed();
    comment.edit({ commentKey: "APP-1#1", text: "Text C" }, human);

    expectValueChanged(
      () => comment.edit({ commentKey: "APP-1#1", text: "Text B", expected: { text: "Text A" } }, human),
      commentConflict,
    );
    expectValueChanged(
      () => comment.edit({ commentKey: "APP-1#1", text: "Text C", expected: { text: "Text A" } }, human),
      commentConflict,
    );
    expect(storedComment().text).toBe("Text C");
  });
});

test("comment edits: a matching expected text lets the edit through", () => {
  withTestStore(() => {
    seed();
    const result = comment.edit({ commentKey: "APP-1#1", text: "Text B", expected: { text: "Text A" } }, human);

    expect(result.changed).toBe(true);
    expect(storedComment().text).toBe("Text B");
  });
});

test("comment edits: --append and --replacing are guarded by the whole stored text, before the text is matched", () => {
  withTestStore(() => {
    seed();
    comment.edit({ commentKey: "APP-1#1", text: "Text C" }, human);

    expectValueChanged(
      () => comment.edit({ commentKey: "APP-1#1", text: { append: "More" }, expected: { text: "Text A" } }, human),
      commentConflict,
    );
    // ? "missing" matches nothing, so without the guard this would fail with text_match_count.
    expectValueChanged(
      () =>
        comment.edit(
          { commentKey: "APP-1#1", text: { find: "missing", replace: "x" }, expected: { text: "Text A" } },
          human,
        ),
      commentConflict,
    );

    comment.edit({ commentKey: "APP-1#1", text: { append: "More" }, expected: { text: "Text C" } }, human);
    comment.edit(
      { commentKey: "APP-1#1", text: { find: "More", replace: "Less" }, expected: { text: "Text C\n\nMore" } },
      human,
    );
    expect(storedComment().text).toBe("Text C\n\nLess");
  });
});

test("comment edits: a blank expected text is invalid", () => {
  withTestStore(() => {
    seed();
    expect(() => comment.edit({ commentKey: "APP-1#1", text: "Text B", expected: { text: " " } }, human)).toThrow(
      InputValidationError,
    );
    expect(storedComment().text).toBe("Text A");
  });
});

test("comment edits: an edit without an expected text still writes over a changed text", () => {
  withTestStore(() => {
    seed();
    comment.edit({ commentKey: "APP-1#1", text: "Text C" }, human);
    comment.edit({ commentKey: "APP-1#1", text: "Text B" }, human);

    expect(storedComment().text).toBe("Text B");
  });
});

test("project edits: a stale expected value refuses the edit, also when the stored value equals the new one", () => {
  withTestStore(() => {
    seed();
    project.edit({ projectKey: "APP", description: "Description C" }, human);

    expectValueChanged(
      () =>
        project.edit(
          { projectKey: "APP", description: "Description B", expected: { description: "Description A" } },
          human,
        ),
      projectConflict(["description"]),
    );
    expectValueChanged(
      () =>
        project.edit(
          { projectKey: "app", description: "Description C", expected: { description: "Description A" } },
          human,
        ),
      projectConflict(["description"]),
    );
    expect(storedProject().description).toBe("Description C");
  });
});

test("project edits: matching expected values let the edit through, and an unguarded field keeps another client's value", () => {
  withTestStore(() => {
    seed();
    project.edit({ projectKey: "APP", description: "Description C" }, human);

    const result = project.edit({ projectKey: "APP", name: "Name B", expected: { name: "Name A" } }, human);
    expect(result.changed).toBe(true);
    expect(storedProject()).toEqual({ name: "Name B", description: "Description C" });
  });
});

test("project edits: one stale value among two edited fields refuses both", () => {
  withTestStore(() => {
    seed();
    project.edit({ projectKey: "APP", description: "Description C" }, human);

    expectValueChanged(
      () =>
        project.edit(
          {
            projectKey: "APP",
            name: "Name B",
            description: "Description B",
            expected: { name: "Name A", description: "Description A" },
          },
          human,
        ),
      projectConflict(["description"]),
    );
    expectValueChanged(
      () =>
        project.edit(
          {
            projectKey: "APP",
            name: "Name B",
            description: "Description B",
            expected: { description: "Description A", name: "Other" },
          },
          human,
        ),
      projectConflict(["name", "description"]),
    );
  });
});

test("project edits: an expected empty description matches no description and refuses a set one", () => {
  withTestStore(() => {
    seed();
    expectValueChanged(
      () => project.edit({ projectKey: "APP", name: "Name B", expected: { description: "" } }, human),
      projectConflict(["description"]),
    );

    project.edit({ projectKey: "APP", description: "" }, human);
    for (const description of [null, "", " \n"]) {
      expect(project.edit({ projectKey: "APP", name: `Name ${activityCount()}`, expected: { description } }, human).changed).toBe(true);
    }
  });
});

test("project edits: --append and --replacing are guarded by the whole stored description", () => {
  withTestStore(() => {
    seed();
    project.edit({ projectKey: "APP", description: "Description C" }, human);

    expectValueChanged(
      () =>
        project.edit(
          { projectKey: "APP", description: { append: "More" }, expected: { description: "Description A" } },
          human,
        ),
      projectConflict(["description"]),
    );
    expectValueChanged(
      () =>
        project.edit(
          {
            projectKey: "APP",
            description: { find: "missing", replace: "x" },
            expected: { description: "Description A" },
          },
          human,
        ),
      projectConflict(["description"]),
    );

    project.edit(
      { projectKey: "APP", description: { find: "C", replace: "D" }, expected: { description: "Description C" } },
      human,
    );
    expect(storedProject().description).toBe("Description D");
  });
});

test("project edits: expected values alone are not an edit, and an unguarded edit writes over a changed value", () => {
  withTestStore(() => {
    seed();
    const before = activityCount();
    expect(() => project.edit({ projectKey: "APP", expected: { name: "Name A" } }, human)).toThrow(
      InputValidationError,
    );
    expect(activityCount()).toBe(before);

    project.edit({ projectKey: "APP", name: "Name C" }, human);
    project.edit({ projectKey: "APP", name: "Name B" }, human);
    expect(storedProject().name).toBe("Name B");
  });
});

test("label edits: a stale expected value refuses the edit, also when the stored value equals the new one", () => {
  withTestStore(() => {
    seed();
    label.edit({ labelName: "bug", color: "blue" }, human);

    expectValueChanged(
      () => label.edit({ labelName: "bug", color: "green", expected: { color: "red" } }, human),
      labelConflict(["color"]),
    );
    expectValueChanged(
      () => label.edit({ labelName: "BUG", color: "blue", expected: { color: "red" } }, human),
      labelConflict(["color"]),
    );
    expect(storedLabel().color).toBe("blue");
  });
});

test("label edits: a stale value wins over a name conflict", () => {
  withTestStore(() => {
    seed();
    label.create({ name: "defect" }, human);
    label.edit({ labelName: "bug", color: "blue" }, human);

    expectValueChanged(
      () => label.edit({ labelName: "bug", name: "defect", expected: { color: "red" } }, human),
      labelConflict(["color"]),
    );
  });
});

test("label edits: matching expected values let the edit through, and an unguarded field keeps another client's value", () => {
  withTestStore(() => {
    seed();
    label.edit({ labelName: "bug", description: "Description C" }, human);

    const result = label.edit(
      { labelName: "bug", name: "defect", color: "blue", expected: { name: "bug", color: "red" } },
      human,
    );
    expect(result.changed).toBe(true);
    expect(storedLabel()).toEqual({ name: "defect", description: "Description C", color: "blue" });
  });
});

test("label edits: one stale value among two edited fields refuses both, naming fields in order", () => {
  withTestStore(() => {
    seed();
    label.edit({ labelName: "bug", description: "Description C" }, human);

    expectValueChanged(
      () =>
        label.edit(
          {
            labelName: "bug",
            name: "defect",
            description: "Description B",
            expected: { name: "bug", description: "Description A" },
          },
          human,
        ),
      labelConflict(["description"]),
    );
    expectValueChanged(
      () =>
        label.edit(
          {
            labelName: "bug",
            name: "defect",
            description: "Description B",
            expected: { color: "blue", description: "Description A", name: "Bug" },
          },
          human,
        ),
      labelConflict(["name", "description", "color"]),
    );
  });
});

test("label edits: an expected empty description matches no description and refuses a set one", () => {
  withTestStore(() => {
    seed();
    expectValueChanged(
      () => label.edit({ labelName: "bug", color: "blue", expected: { description: "" } }, human),
      labelConflict(["description"]),
    );

    label.edit({ labelName: "bug", description: "" }, human);
    for (const [description, color] of [[null, "blue"], ["", "green"], [" \n", "yellow"]] as const) {
      expect(label.edit({ labelName: "bug", color, expected: { description } }, human).changed).toBe(true);
    }
  });
});

test("label edits: --append and --replacing are guarded by the whole stored description", () => {
  withTestStore(() => {
    seed();
    label.edit({ labelName: "bug", description: "Description C" }, human);

    expectValueChanged(
      () =>
        label.edit(
          { labelName: "bug", description: { append: "More" }, expected: { description: "Description A" } },
          human,
        ),
      labelConflict(["description"]),
    );
    expectValueChanged(
      () =>
        label.edit(
          {
            labelName: "bug",
            description: { find: "missing", replace: "x" },
            expected: { description: "Description A" },
          },
          human,
        ),
      labelConflict(["description"]),
    );

    label.edit(
      { labelName: "bug", description: { find: "C", replace: "D" }, expected: { description: "Description C" } },
      human,
    );
    expect(storedLabel().description).toBe("Description D");
  });
});

test("label edits: expected values alone are not an edit, and an unguarded edit writes over a changed value", () => {
  withTestStore(() => {
    seed();
    const before = activityCount();
    expect(() => label.edit({ labelName: "bug", expected: { color: "red" } }, human)).toThrow(InputValidationError);
    expect(activityCount()).toBe(before);

    label.edit({ labelName: "bug", color: "blue" }, human);
    label.edit({ labelName: "bug", color: "green" }, human);
    expect(storedLabel().color).toBe("green");
  });
});
