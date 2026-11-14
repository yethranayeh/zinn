import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorDocumentSchema } from "../src/errors";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

// ? ZINN-580: --expect-* flags refuse a task edit when a stored value differs from the expected one.

type StoredTask = { title: string; description: string | null; priority: string | null; due_at: number | null };

const storedTask = (dir: string) =>
  withTestDb(dir, (db) =>
    db.query<StoredTask, []>("SELECT title, description, priority, due_at FROM task").get()!,
  );

const countEdits = (dir: string) =>
  withTestDb(dir, (db) =>
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM activity WHERE action = 'edit'").get()!.count,
  );

const parseError = (stderr: string) => errorDocumentSchema.parse(JSON.parse(stderr)).error;

function runZinnWithStdin(args: string[], dir: string, stdin: string) {
  return runProcessAsync([process.execPath, CLI_PATH, ...args], {
    env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir },
    cwd: dir,
    stdin: Buffer.from(stdin),
  });
}

// ? Creates APP-1 with title "Title A" and description "A", then another client stores description "C".
async function seedChangedTask(dir: string) {
  expect((await runZinn(["project", "create", "APP"], dir)).code).toBe(0);
  expect((await runZinn(["task", "create", "APP", "--title", "Title A", "--description", "A"], dir)).code).toBe(0);
  expect((await runZinn(["task", "edit", "APP-1", "--description", "C"], dir)).code).toBe(0);
}

async function expectValueChanged(dir: string, args: string[], changedFields: string[]) {
  const before = { task: storedTask(dir), edits: countEdits(dir) };
  const result = await runZinn(["task", "edit", "APP-1", ...args, "--json"], dir);

  expect(result.code, args.join(" ")).toBe(1);
  expect(result.stdout).toBe("");
  expect(parseError(result.stderr)).toMatchObject({
    code: "conflict",
    details: { entity: "task", key: "APP-1", reason: "value_changed", changedFields },
  });
  expect({ task: storedTask(dir), edits: countEdits(dir) }).toEqual(before);
}

async function expectEdited(dir: string, args: string[]) {
  const result = await runZinn(["task", "edit", "APP-1", ...args, "--json"], dir);
  expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0);
}

test("a stale expected value refuses the edit without writes, even when the stored value equals the new one", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChangedTask(dir);

    await expectValueChanged(dir, ["--description", "B", "--expect-description", "A"], ["description"]);
    expect(storedTask(dir).description).toBe("C");
    await expectValueChanged(dir, ["--description", "C", "--expect-description", "A"], ["description"]);

    const human = await runZinn(["task", "edit", "APP-1", "--description", "B", "--expect-description", "A"], dir);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("APP-1");
  });
}, 30_000);

test("matching expected values let the edit through, and an unguarded field keeps another client's value", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChangedTask(dir);

    await expectEdited(dir, ["--title", "Title B", "--expect-title", "Title A"]);
    expect(storedTask(dir)).toMatchObject({ title: "Title B", description: "C" });

    await expectEdited(dir, ["--description", "B", "--expect-description", "C"]);
    expect(storedTask(dir)).toMatchObject({ title: "Title B", description: "B" });
  });
}, 30_000);

test("one mismatch among guarded fields refuses every field and names only the mismatched ones", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChangedTask(dir);

    await expectValueChanged(
      dir,
      ["--title", "Title B", "--description", "B", "--expect-title", "Title A", "--expect-description", "A"],
      ["description"],
    );
    await expectValueChanged(
      dir,
      ["--title", "Title B", "--description", "B", "--expect-title", "Other", "--expect-description", "A"],
      ["title", "description"],
    );
  });
}, 30_000);

test("expected empty values match empty fields and refuse set ones", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChangedTask(dir);
    await expectEdited(dir, ["--description", ""]);

    await expectEdited(dir, [
      "--title", "Title B",
      "--expect-description", "",
      "--expect-priority", "none",
      "--expect-due", "none",
    ]);

    await expectEdited(dir, ["--description", "Set", "--priority", "high", "--due", "2026-01-15T00:00:00Z"]);
    await expectValueChanged(
      dir,
      ["--title", "Title C", "--expect-description", "", "--expect-priority", "none", "--expect-due", "none"],
      ["description", "priority", "due_at"],
    );
    await expectEdited(dir, [
      "--title", "Title C",
      "--expect-priority", "HIGH",
      "--expect-due", String(Date.UTC(2026, 0, 15)),
    ]);
  });
}, 30_000);

test("--append and --replacing are guarded by the whole stored description, before the text is matched", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChangedTask(dir);

    await expectValueChanged(dir, ["--description", "More", "--append", "--expect-description", "A"], ["description"]);
    await expectValueChanged(
      dir,
      ["--description", "x", "--replacing", "missing", "--expect-description", "A"],
      ["description"],
    );

    await expectEdited(dir, ["--description", "D", "--replacing", "C", "--expect-description", "C"]);
    expect(storedTask(dir).description).toBe("D");
  });
}, 30_000);

test("an expected value may guard a field the edit does not change", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChangedTask(dir);

    await expectValueChanged(dir, ["--title", "Title B", "--expect-description", "A"], ["description"]);
    await expectEdited(dir, ["--title", "Title B", "--expect-description", "C"]);
    expect(storedTask(dir)).toMatchObject({ title: "Title B", description: "C" });
  });
}, 30_000);

test("an edit without expected values still writes over a changed value", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChangedTask(dir);

    await expectEdited(dir, ["--description", "B"]);
    expect(storedTask(dir).description).toBe("B");
  });
}, 30_000);

test("--expect-description-file reads the expected text from a file or stdin", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChangedTask(dir);
    const path = join(dir, "expected.md");
    writeFileSync(path, "C\n");

    await expectEdited(dir, ["--title", "Title B", "--expect-description-file", path]);
    expect(storedTask(dir).title).toBe("Title B");

    const fromStdin = await runZinnWithStdin(
      ["task", "edit", "APP-1", "--title", "Title C", "--expect-description-file", "-", "--json"],
      dir,
      "C\n",
    );
    expect(fromStdin.code, fromStdin.stderr).toBe(0);
    expect(storedTask(dir).title).toBe("Title C");

    const stale = await runZinnWithStdin(
      ["task", "edit", "APP-1", "--title", "Title D", "--expect-description-file", "-", "--json"],
      dir,
      "A\n",
    );
    expect(stale.code).toBe(1);
    expect(parseError(stale.stderr).details).toMatchObject({ reason: "value_changed", changedFields: ["description"] });
    expect(storedTask(dir).title).toBe("Title C");
  });
}, 30_000);

test("expect flag usage errors come before any text is read or the database opens", async () => {
  await withIsolatedZinnDir(async (dir) => {
    // ? Reading the missing file would fail as not_found, so invalid_input shows nothing was read.
    const missing = join(dir, "missing.md");
    const cases: Array<[string[], string]> = [
      [["--title", "T", "--expect-description", "A", "--expect-description-file", missing], "--expect-description-file"],
      [["--title", "T", "--expect-title", "A", "--expect-title", "B"], "--expect-title"],
      [["--title", "T", "--expect-description", "A", "--expect-description", "B"], "--expect-description"],
      [["--title", "T", "--expect-description-file", missing, "--expect-description-file", missing], "--expect-description-file"],
      [["--title", "T", "--expect-priority", "low", "--expect-priority", "high"], "--expect-priority"],
      [["--title", "T", "--expect-due", "none", "--expect-due", "none"], "--expect-due"],
      [["--description-file", "-", "--expect-description-file", "-"], "--expect-description-file"],
      [["--expect-priority", "soon", "--description-file", missing], "--expect-priority"],
      [["--expect-due", "tomorrow", "--description-file", missing], "--expect-due"],
      [["--expect-title", " ", "--description-file", missing], "title"],
      [["--expect-title", "Title A", "--expect-description-file", missing], "field"],
    ];

    for (const [args, fact] of cases) {
      const result = await runZinnWithStdin(["task", "edit", "APP-1", ...args, "--json"], dir, "piped\n");
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      const error = parseError(result.stderr);
      expect(error.code, args.join(" ")).toBe("invalid_input");
      expect(JSON.stringify(error), args.join(" ")).toContain(fact);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 30_000);

test("expected values alone fail with the existing at-least-one-edit-flag error", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedChangedTask(dir);
    const plain = await runZinn(["task", "edit", "APP-1", "--json"], dir);
    const expectOnly = await runZinn(["task", "edit", "APP-1", "--expect-title", "Title A", "--json"], dir);

    expect(expectOnly.code).toBe(1);
    expect(parseError(expectOnly.stderr)).toEqual(parseError(plain.stderr));
  });
}, 30_000);

test("concurrent guarded edits of one task from the same base let exactly one succeed", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const editorCount = 8;
    expect((await runZinn(["project", "create", "APP"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Task", "--description", "Base"], dir)).code).toBe(0);

    const results = await Promise.all(
      Array.from({ length: editorCount }, (_, index) =>
        runZinn(
          ["--json", "task", "edit", "APP-1", "--description", `Editor ${index}`, "--expect-description", "Base"],
          dir,
        ),
      ),
    );

    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    for (const result of results.filter((result) => result.code !== 0)) {
      expect(parseError(result.stderr).details?.reason).toBe("value_changed");
    }
    expect(countEdits(dir)).toBe(1);
  });
}, 30_000);
