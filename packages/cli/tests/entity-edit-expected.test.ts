import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorDocumentSchema } from "../src/errors";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

// ? ZINN-581: --expect-* flags refuse a comment, project or label edit when a stored value differs from the expected one.

type Stored = {
  comment: { text: string };
  project: { name: string; description: string | null };
  label: { name: string; description: string | null; color: string };
  activity: number;
};

const stored = (dir: string): Stored =>
  withTestDb(dir, (db) => ({
    comment: db.query<Stored["comment"], []>("SELECT text FROM comment").get()!,
    project: db.query<Stored["project"], []>("SELECT name, description FROM project").get()!,
    label: db.query<Stored["label"], []>("SELECT name, description, color FROM label").get()!,
    activity: db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM activity").get()!.count,
  }));

const parseError = (stderr: string) => errorDocumentSchema.parse(JSON.parse(stderr)).error;

function runZinnWithStdin(args: string[], dir: string, stdin: string) {
  return runProcessAsync([process.execPath, CLI_PATH, ...args], {
    env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir },
    cwd: dir,
    stdin: Buffer.from(stdin),
  });
}

const commentEdit = ["task", "comment", "edit", "APP-1#1"];
const projectEdit = ["project", "edit", "APP"];
const labelEdit = ["label", "edit", "bug"];

// ? Seeds values "A", then another client stores "C" in the comment text, the project description and the label description.
async function seedChanged(dir: string) {
  const setup = [
    ["project", "create", "APP", "--name", "Name A", "--description", "A"],
    ["task", "create", "APP", "--title", "Task"],
    ["task", "comment", "create", "APP-1", "--text", "A"],
    ["label", "create", "bug", "--description", "A", "--color", "red"],
    [...commentEdit, "--text", "C"],
    [...projectEdit, "--description", "C"],
    [...labelEdit, "--description", "C"],
  ];
  for (const args of setup) {
    expect((await runZinn(args, dir)).code, args.join(" ")).toBe(0);
  }
}

async function expectValueChanged(
  dir: string,
  args: string[],
  facts: { entity: string; key: string; changedFields: string[] },
) {
  const before = stored(dir);
  const result = await runZinn([...args, "--json"], dir);

  expect(result.code, args.join(" ")).toBe(1);
  expect(result.stdout).toBe("");
  expect(parseError(result.stderr)).toMatchObject({
    code: "conflict",
    details: { ...facts, reason: "value_changed" },
  });
  expect(stored(dir)).toEqual(before);
}

async function expectEdited(dir: string, args: string[]) {
  const result = await runZinn([...args, "--json"], dir);
  expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0);
}

const commentConflict = { entity: "comment", key: "APP-1#1", changedFields: ["text"] };
const projectConflict = (changedFields: string[]) => ({ entity: "project", key: "APP", changedFields });
const labelConflict = (changedFields: string[]) => ({ entity: "label", key: "bug", changedFields });

test("task comment edit: a stale --expect-text refuses the edit, and a matching one lets it through", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);

    await expectValueChanged(dir, [...commentEdit, "--text", "B", "--expect-text", "A"], commentConflict);
    await expectValueChanged(dir, [...commentEdit, "--text", "C", "--expect-text", "A"], commentConflict);
    await expectValueChanged(dir, [...commentEdit, "--text", "More", "--append", "--expect-text", "A"], commentConflict);
    await expectValueChanged(
      dir,
      [...commentEdit, "--text", "x", "--replacing", "missing", "--expect-text", "A"],
      commentConflict,
    );
    expect(stored(dir).comment.text).toBe("C");

    await expectEdited(dir, [...commentEdit, "--text", "D", "--replacing", "C", "--expect-text", "C"]);
    await expectEdited(dir, [...commentEdit, "--text", "More", "--append", "--expect-text", "D"]);
    expect(stored(dir).comment.text).toBe("D\n\nMore");

    await expectEdited(dir, [...commentEdit, "--text", "B"]);
    expect(stored(dir).comment.text).toBe("B");
  });
}, 30_000);

test("task comment edit: --expect-text-file reads the expected text from a file or stdin", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);
    const path = join(dir, "expected.md");
    writeFileSync(path, "C\n");

    await expectEdited(dir, [...commentEdit, "--text", "D", "--expect-text-file", path]);
    const fromStdin = await runZinnWithStdin([...commentEdit, "--text", "E", "--expect-text-file", "-", "--json"], dir, "D\n");
    expect(fromStdin.code, fromStdin.stderr).toBe(0);
    expect(stored(dir).comment.text).toBe("E");
  });
}, 30_000);

test("project edit: stale expected values refuse every field, and matching ones let the edit through", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);

    await expectValueChanged(dir, [...projectEdit, "--description", "B", "--expect-description", "A"], projectConflict(["description"]));
    await expectValueChanged(dir, [...projectEdit, "--description", "C", "--expect-description", "A"], projectConflict(["description"]));
    await expectValueChanged(
      dir,
      [...projectEdit, "--name", "Name B", "--description", "B", "--expect-name", "Name A", "--expect-description", "A"],
      projectConflict(["description"]),
    );
    await expectValueChanged(
      dir,
      [...projectEdit, "--name", "Name B", "--expect-name", "Other", "--expect-description", "A"],
      projectConflict(["name", "description"]),
    );

    await expectEdited(dir, [...projectEdit, "--name", "Name B", "--expect-name", "Name A"]);
    expect(stored(dir).project).toEqual({ name: "Name B", description: "C" });
  });
}, 30_000);

test("project edit: --append and --replacing are guarded by the whole stored description", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);

    await expectValueChanged(
      dir,
      [...projectEdit, "--description", "More", "--append", "--expect-description", "A"],
      projectConflict(["description"]),
    );
    await expectValueChanged(
      dir,
      [...projectEdit, "--description", "x", "--replacing", "missing", "--expect-description", "A"],
      projectConflict(["description"]),
    );
    await expectEdited(dir, [...projectEdit, "--description", "D", "--replacing", "C", "--expect-description", "C"]);
    expect(stored(dir).project.description).toBe("D");
  });
}, 30_000);

test("project edit: --expect-description '' matches no description and refuses a set one", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);

    await expectValueChanged(dir, [...projectEdit, "--name", "Name B", "--expect-description", ""], projectConflict(["description"]));
    await expectEdited(dir, [...projectEdit, "--description", ""]);
    await expectEdited(dir, [...projectEdit, "--name", "Name B", "--expect-description", ""]);
    expect(stored(dir).project).toEqual({ name: "Name B", description: null });
  });
}, 30_000);

test("project edit: an edit without expected values still writes over a changed value", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);
    await expectEdited(dir, [...projectEdit, "--description", "B"]);
    expect(stored(dir).project.description).toBe("B");
  });
}, 30_000);

test("label edit: stale expected values refuse every field, and matching ones let the edit through", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);

    await expectValueChanged(dir, [...labelEdit, "--description", "B", "--expect-description", "A"], labelConflict(["description"]));
    await expectValueChanged(dir, [...labelEdit, "--description", "C", "--expect-description", "A"], labelConflict(["description"]));
    await expectValueChanged(
      dir,
      [...labelEdit, "--name", "defect", "--description", "B", "--expect-name", "bug", "--expect-description", "A"],
      labelConflict(["description"]),
    );
    await expectValueChanged(
      dir,
      [...labelEdit, "--color", "blue", "--expect-color", "green", "--expect-description", "A", "--expect-name", "Bug"],
      labelConflict(["name", "description", "color"]),
    );

    await expectEdited(dir, [...labelEdit, "--color", "blue", "--expect-color", "red", "--expect-name", "bug"]);
    expect(stored(dir).label).toEqual({ name: "bug", description: "C", color: "blue" });
  });
}, 30_000);

test("label edit: --append and --replacing are guarded by the whole stored description", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);

    await expectValueChanged(
      dir,
      [...labelEdit, "--description", "More", "--append", "--expect-description", "A"],
      labelConflict(["description"]),
    );
    await expectValueChanged(
      dir,
      [...labelEdit, "--description", "x", "--replacing", "missing", "--expect-description", "A"],
      labelConflict(["description"]),
    );
    await expectEdited(dir, [...labelEdit, "--description", "D", "--replacing", "C", "--expect-description", "C"]);
    expect(stored(dir).label.description).toBe("D");
  });
}, 30_000);

test("label edit: --expect-description '' matches no description and refuses a set one", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);

    await expectValueChanged(dir, [...labelEdit, "--color", "blue", "--expect-description", ""], labelConflict(["description"]));
    await expectEdited(dir, [...labelEdit, "--description", ""]);
    await expectEdited(dir, [...labelEdit, "--color", "blue", "--expect-description", ""]);
    expect(stored(dir).label).toEqual({ name: "bug", description: null, color: "blue" });
  });
}, 30_000);

test("label edit: an edit without expected values still writes over a changed value", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);
    await expectEdited(dir, [...labelEdit, "--description", "B"]);
    expect(stored(dir).label.description).toBe("B");
  });
}, 30_000);

test("expect flags without an edit flag fail as usage errors and read nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChanged(dir);
    // ? Reading the missing file would fail as not_found, so invalid_input shows nothing was read.
    const missing = join(dir, "missing.md");
    const cases = [
      [...commentEdit, "--expect-text", "C"],
      [...commentEdit, "--expect-text-file", missing],
      [...commentEdit, "--expect-text-file", "-"],
      [...projectEdit, "--expect-name", "Name A"],
      [...projectEdit, "--expect-description-file", missing],
      [...projectEdit, "--expect-description-file", "-"],
      [...labelEdit, "--expect-color", "red"],
      [...labelEdit, "--expect-description-file", missing],
      [...labelEdit, "--expect-description-file", "-"],
    ];
    const before = stored(dir);

    for (const args of cases) {
      const result = await runZinnWithStdin([...args, "--json"], dir, "piped\n");
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(parseError(result.stderr).code, args.join(" ")).toBe("invalid_input");
    }
    expect(stored(dir)).toEqual(before);
  });
}, 30_000);

test("expect flag usage errors come before any text is read or the database opens", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const missing = join(dir, "missing.md");
    const cases: Array<[string[], string]> = [
      [[...commentEdit, "--text-file", "-", "--expect-text-file", "-"], "--expect-text-file"],
      [[...commentEdit, "--text", "B", "--expect-text", "A", "--expect-text-file", missing], "--expect-text-file"],
      [[...projectEdit, "--description-file", "-", "--expect-description-file", "-"], "--expect-description-file"],
      [[...projectEdit, "--expect-name", " ", "--description-file", missing], "name"],
      [[...labelEdit, "--description-file", "-", "--expect-description-file", "-"], "--expect-description-file"],
      [[...labelEdit, "--expect-color", "pink", "--description-file", missing], "color"],
      [[...labelEdit, "--expect-name", " ", "--description-file", missing], "name"],
    ];

    for (const [args, fact] of cases) {
      const result = await runZinnWithStdin([...args, "--json"], dir, "piped\n");
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      const error = parseError(result.stderr);
      expect(error.code, args.join(" ")).toBe("invalid_input");
      expect(JSON.stringify(error), args.join(" ")).toContain(fact);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 30_000);
