import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorDocumentSchema } from "../src/errors";
import { generateInputUsage } from "../src/input";
import { parseRoutes } from "../src/routes/router";
import { routes } from "../src/routes/routes";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

// ? ZINN-69: --description-file and --text-file read text from a file, or from stdin as "-".

type TextFlag = "--description" | "--text";
type TextCommand = {
  flag: TextFlag;
  // ? The command's words; `id` keeps each created entity unique.
  args: (id: number) => string[];
};

// ? Seeds with seedText() create APP, APP-1, label bug and comment APP-1#1.
const textCommands: Record<string, TextCommand> = {
  "project create": { flag: "--description", args: (id) => ["project", "create", `NEW${id}`] },
  "project edit": { flag: "--description", args: () => ["project", "edit", "APP"] },
  "task create": { flag: "--description", args: (id) => ["task", "create", "APP", "--title", `Task ${id}`] },
  "task edit": { flag: "--description", args: () => ["task", "edit", "APP-1"] },
  "label create": { flag: "--description", args: (id) => ["label", "create", `new-${id}`] },
  "label edit": { flag: "--description", args: () => ["label", "edit", "bug"] },
  "task comment create": { flag: "--text", args: () => ["task", "comment", "create", "APP-1"] },
  "task comment edit": { flag: "--text", args: () => ["task", "comment", "edit", "APP-1#1"] },
};
const editCommands = Object.entries(textCommands).filter(([command]) => command.endsWith(" edit"));
const SEED_TEXT = "Seed text, kept";
const fieldOf = (flag: TextFlag) => flag.slice(2);
let nextId = 0;

async function seedText(dir: string) {
  for (const args of [
    ["project", "create", "APP", "--description", SEED_TEXT],
    ["task", "create", "APP", "--title", "Task", "--description", SEED_TEXT],
    ["label", "create", "bug", "--description", SEED_TEXT],
    ["task", "comment", "create", "APP-1", "--text", SEED_TEXT],
  ]) {
    expect((await runZinn(args, dir)).code).toBe(0);
  }
}

const snapshot = (dir: string) =>
  withTestDb(dir, (db) =>
    Object.fromEntries(
      ["project", "project_column", "task", "label", "comment", "activity"].map((table) => [
        table,
        db.query(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    ),
  );

function runZinnWithStdin(args: string[], dir: string, stdin: string | Uint8Array) {
  return runProcessAsync([process.execPath, CLI_PATH, ...args], {
    env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir },
    cwd: dir,
    stdin: typeof stdin === "string" ? Buffer.from(stdin) : stdin,
  });
}

function parseError(stderr: string) {
  return errorDocumentSchema.parse(JSON.parse(stderr)).error;
}

test("the table of text commands covers every route command with a text flag", () => {
  const withTextFlag = parseRoutes(routes)
    .filter(({ input }) => "description" in input.options || "text" in input.options)
    .map(({ command }) => command);

  expect(withTextFlag.sort()).toEqual(Object.keys(textCommands).sort());
});

test("every text flag has a file flag declared as its alternative, with the same modifiers and help", () => {
  for (const { command, input, help } of parseRoutes(routes)) {
    const name = "description" in input.options ? "description" : "text" in input.options ? "text" : null;
    if (name === null) {
      continue;
    }

    const inline = `option:${name}` as const;
    const file = `option:${name}-file` as const;
    const constraints: unknown[] = [...input.constraints];
    expect(input.options[`${name}-file`], command).toMatchObject({ type: "string", value: { kind: "path" } });
    expect(constraints).toContainEqual({ kind: "exclusive", members: [inline, file] });

    for (const constraint of input.constraints) {
      const members = "members" in constraint ? constraint.members : [];
      if (constraint.kind !== "exclusive" && members.includes(inline)) {
        expect(members, `${command}: ${constraint.kind}`).toContain(file);
      }
    }
    if ("append" in input.options) {
      for (const modifier of ["option:append", "option:replacing"]) {
        expect(constraints).toContainEqual({ kind: "requiresAny", input: modifier, members: [inline, file] });
      }
    }

    const usage = generateInputUsage(input)[0]!;
    expect(usage).toContain(`--${name} <text>|--${name}-file <path>`);
    expect(help.split("\n\n").slice(1).join("\n")).toContain(`--${name}-file`);
  }
});

test("file input is stored through every text command, without trailing line breaks and with CRLF as LF", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedText(dir);
    const path = join(dir, "notes with spaces ü.md");
    writeFileSync(path, "- Line `one` \"$x\" \\n\r\n{\"json\": true}\r\n\r\n\n");

    for (const [command, { flag, args }] of Object.entries(textCommands)) {
      const result = await runZinn([...args(nextId++), `${flag}-file`, path, "--json"], dir);
      expect(result.code, `${command}: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)[fieldOf(flag)]).toBe("- Line `one` \"$x\" \\n\n{\"json\": true}");
    }
  });
}, 30_000);

test("stdin input is stored through every text command", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedText(dir);

    for (const [command, { flag, args }] of Object.entries(textCommands)) {
      const result = await runZinnWithStdin([...args(nextId++), `${flag}-file`, "-", "--json"], dir, `--from ${command}\n`);
      expect(result.code, `${command}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)[fieldOf(flag)]).toBe(`--from ${command}`);
    }
  });
}, 30_000);

test("stdin larger than one pipe chunk with emoji throughout is stored intact", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedText(dir);
    const PIPE_CHUNK_BYTES = 64 * 1024;
    const line = "Refine 😀 the numbers, 🧇 then count ✅\n";
    const text = line.repeat(Math.ceil((4 * PIPE_CHUNK_BYTES) / Buffer.byteLength(line)));
    expect(Buffer.byteLength(text)).toBeGreaterThan(PIPE_CHUNK_BYTES);

    const edited = await runZinnWithStdin(["task", "edit", "APP-1", "--description-file", "-"], dir, text);
    const commented = await runZinnWithStdin(["task", "comment", "create", "APP-1", "--text-file", "-"], dir, text);

    expect(edited.code, edited.stderr).toBe(0);
    expect(commented.code, commented.stderr).toBe(0);
    const stored = withTestDb(dir, (db) => ({
      task: db.query<{ text: string }, []>("SELECT description AS text FROM task").get()!.text,
      comment: db.query<{ text: string }, []>("SELECT text FROM comment ORDER BY created_at DESC, id DESC").get()!.text,
    }));
    expect(stored).toEqual({ task: text.slice(0, -1), comment: text.slice(0, -1) });
  });
}, 30_000);

test("inline and file input together fail before anything is read, through every text command", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedText(dir);
    const before = snapshot(dir);

    for (const [command, { flag, args }] of Object.entries(textCommands)) {
      // ? A missing path would fail as a read error; the conflict is reported instead.
      for (const path of [join(dir, "missing.md"), "-"]) {
        const result = await runZinnWithStdin([...args(nextId++), flag, "inline", `${flag}-file`, path, "--json"], dir, "piped\n");
        expect(result.code, command).toBe(1);
        expect(result.stdout).toBe("");
        expect(parseError(result.stderr)).toMatchObject({ code: "invalid_input", details: { argument: `${flag}-file` } });
      }
    }
    expect(snapshot(dir)).toEqual(before);
  });
}, 30_000);

test("empty and blank input fails through every text command without changes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedText(dir);
    const before = snapshot(dir);
    const empty = join(dir, "empty.md");
    const blank = join(dir, "blank.md");
    writeFileSync(empty, "");
    writeFileSync(blank, " \t\r\n\n");

    for (const [command, { flag, args }] of Object.entries(textCommands)) {
      const attempts = [
        await runZinn([...args(nextId++), `${flag}-file`, empty, "--json"], dir),
        await runZinn([...args(nextId++), `${flag}-file`, blank, "--json"], dir),
        await runZinnWithStdin([...args(nextId++), `${flag}-file`, "-", "--json"], dir, ""),
        await runZinnWithStdin([...args(nextId++), `${flag}-file`, "-", "--json"], dir, "\n  \n"),
      ];
      for (const result of attempts) {
        expect(result.code, command).toBe(1);
        expect(result.stdout).toBe("");
        expect(parseError(result.stderr)).toMatchObject({ code: "invalid_input", details: { argument: `${flag}-file` } });
      }
    }
    expect(snapshot(dir)).toEqual(before);
  });
}, 30_000);

test("a failed read changes no entity and no activity history through every text command", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedText(dir);
    const before = snapshot(dir);
    const directory = join(dir, "notes");
    mkdirSync(directory);

    for (const [command, { flag, args }] of Object.entries(textCommands)) {
      for (const path of [join(dir, "missing.md"), directory]) {
        const result = await runZinn([...args(nextId++), `${flag}-file`, path, "--json"], dir);
        expect(result.code, command).toBe(1);
        expect(result.stdout).toBe("");
        expect(parseError(result.stderr).details).toMatchObject({ argument: `${flag}-file`, path });
      }
    }
    // ? project create included: no project, default columns or activity rows were added.
    expect(snapshot(dir)).toEqual(before);
  });
}, 30_000);

test("a missing file fails as not_found before any text command opens the database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { flag, args }] of Object.entries(textCommands)) {
      const result = await runZinn([...args(nextId++), `${flag}-file`, join(dir, "missing.md"), "--json"], dir);
      expect(result.code, command).toBe(1);
      expect(parseError(result.stderr)).toMatchObject({ code: "not_found", details: { argument: `${flag}-file` } });
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 30_000);

test("with the project key omitted, the text is read before defaultProject is looked up", async () => {
  await withIsolatedZinnDir(async (dir) => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProject: "APP" }));
    const missing = join(dir, "missing.md");

    for (const args of [["task", "create", "--title", "T"], ["project", "edit"]]) {
      const result = await runZinn([...args, "--description-file", missing, "--json"], dir);
      expect(result.code, args.join(" ")).toBe(1);
      expect(parseError(result.stderr)).toMatchObject({ code: "not_found", details: { argument: "--description-file" } });
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 30_000);

test("usage errors come before the text is read", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const missing = join(dir, "missing.md");
    const cases: Array<[string[], string]> = [
      ...editCommands.flatMap(([, { flag, args }]): Array<[string[], string]> => [
        [[...args(0), `${flag}-file`, missing, "--append", "--replacing", "old"], "--append"],
        [[...args(0), `${flag}-file`, missing, "--all"], "--all"],
        [[...args(0), `${flag}-file`, missing, `${flag}-file`, missing], `${flag}-file`],
      ]),
      [["task", "create", "APP", "--description-file", missing], "--title"],
      [["task", "create", "APP", "--title", "T", "--priority", "soon", "--description-file", missing], "--priority"],
      [["task", "edit", "APP-1", "--priority", "soon", "--description-file", missing], "--priority"],
      [["label", "create", "new", "--color", "purple", "--description-file", missing], "color"],
      [["label", "edit", "bug", "--color", "purple", "--description-file", missing], "color"],
      [["label", "create", " ", "--description-file", missing], "name"],
      [["label", "edit", "bug", "--name", " ", "--description-file", missing], "name"],
      [["project", "create", "1BAD", "--description-file", missing], "key"],
      [["project", "edit", "APP", "--name", " ", "--description-file", missing], "name"],
      [["task", "create", "APP", "--title", " ", "--description-file", missing], "title"],
      [["task", "create", "APP", "--title", "T", "--label", " ", "--description-file", missing], "labelNames"],
      [["task", "edit", "APP-1", "--title", " ", "--description-file", missing], "title"],
      [["task", "comment", "create", "APP-1", "extra", "--text-file", missing], "extra"],
    ];

    for (const [args, fact] of cases) {
      const result = await runZinn([...args, "--json"], dir);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      const error = parseError(result.stderr);
      expect(error.code).toBe("invalid_input");
      expect(JSON.stringify(error)).toContain(fact);
      expect(JSON.stringify(error)).not.toContain(missing);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 30_000);

test("--append and --replacing take their text from a file or stdin through every edit command", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedText(dir);
    const appended = join(dir, "appended.md");
    writeFileSync(appended, "- Appended\n");

    for (const [command, { flag, args }] of editCommands) {
      const field = fieldOf(flag);
      const append = await runZinn([...args(0), `${flag}-file`, appended, "--append", "--json"], dir);
      expect(append.code, `${command}: ${append.stderr}`).toBe(0);
      expect(JSON.parse(append.stdout)[field]).toBe(`${SEED_TEXT}\n\n- Appended`);

      const replace = await runZinnWithStdin([...args(0), `${flag}-file`, "-", "--replacing", "e", "--all", "--json"], dir, "E\n");
      expect(replace.code, `${command}: ${replace.stderr}`).toBe(0);
      expect(JSON.parse(replace.stdout)[field]).toBe(`${SEED_TEXT}\n\n- Appended`.replaceAll("e", "E"));
    }
  });
}, 30_000);

test("file input combines with the other fields of an edit", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedText(dir);
    const path = join(dir, "description.md");
    writeFileSync(path, "From a file\n");
    const edits: Array<[string[], Record<string, string>]> = [
      [["project", "edit", "APP", "--name", "Renamed"], { name: "Renamed" }],
      [["task", "edit", "APP-1", "--title", "Retitled", "--priority", "high"], { title: "Retitled", priority: "high" }],
      [["label", "edit", "bug", "--color", "red"], { color: "red" }],
    ];

    for (const [args, fields] of edits) {
      const result = await runZinn([...args, "--description-file", path, "--json"], dir);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ...fields, description: "From a file" });
    }
  });
}, 30_000);
