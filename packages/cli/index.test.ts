import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

import packageJson from "./package.json";
import { parseRoutes } from "./src/routes/router";
import { routes } from "./src/routes/routes";
import type { Activity } from "@zinn-dev/core";

// ? End-to-end tests: each case spawns the real bin, so `ZINN_DIR` is passed
// ? per-spawn rather than set on `process.env`. The route table is imported only
// ? to list the commands; nothing in this process opens a database.
// ? Subprocesses are the only option while `quit()` calls
// ? `process.exit` — see the refactor TODO at the bottom of this file.
//
// ? `.todo` cases below cover behavior that cannot be asserted yet. Bun skips
// ? them by default; `bun test --todo` runs them and fails any that *pass*
// ? ("marked as todo but passes"), so each one retires itself once its blocker
// ? is built.

const PREFIX = join(tmpdir(), "zinntest-");
const TEST_DIR = mkdtempSync(PREFIX);
// ? Resolved from this file so the suite does not depend on the cwd it is run from.
const CLI_PATH = join(import.meta.dir, "index.ts");
const GRAY_BACKLOG = "\x1b[90mBacklog\x1b[39m";
const GREEN_DONE = "\x1b[32mDone\x1b[39m";
// ? Chrome (separators, empty markers, timestamps) is dimmed, never colored: SGR 2 on, SGR 22 off.
const DIM_SEPARATOR = "\x1b[2m | \x1b[22m";
const DIM_EMPTY_PRIORITY = "\x1b[2m-\x1b[22m";
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const SECTION_RULE = "-".repeat(60);
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;

afterAll(() => {
  if (!TEST_DIR.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${TEST_DIR}": not a ${PREFIX}* directory`);
  }

  rmSync(TEST_DIR, { recursive: true, force: true });
});

function removeIsolatedZinnDir(testDir: string) {
  if (!testDir.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${testDir}": not a ${PREFIX}* directory`);
  }

  rmSync(testDir, { recursive: true, force: true });
}

function withIsolatedZinnDir(run: (testDir: string) => void) {
  const testDir = mkdtempSync(PREFIX);

  try {
    run(testDir);
  } finally {
    removeIsolatedZinnDir(testDir);
  }
}

// ? Same as withIsolatedZinnDir, but removes the directory only after an async run settles.
async function withIsolatedZinnDirAsync(run: (testDir: string) => Promise<void>) {
  const testDir = mkdtempSync(PREFIX);

  try {
    await run(testDir);
  } finally {
    removeIsolatedZinnDir(testDir);
  }
}

function runZinn(
  args: Array<string>,
  testDir = TEST_DIR,
  additionalEnv: Record<string, string> = {},
) {
  const proc = Bun.spawnSync(["bun", CLI_PATH, ...args], {
    env: { ...process.env, ...additionalEnv, ZINN_DIR: testDir },
  });

  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    code: proc.exitCode,
  };
}

test("names and titles share trimming and reject leading or trailing control characters", () => {
  withIsolatedZinnDir((directory) => {
    const commands = [
      { args: ["project", "create", "TEXT", "--name"], field: "name" },
      { args: ["project", "column", "create", "TEXT"], field: "name" },
      { args: ["label", "create"], field: "name" },
      { args: ["task", "create", "TEXT", "--title"], field: "title" },
    ];
    for (const { args, field } of commands) {
      const created = runZinn([...args, " Café 🌿  next ", "--json"], directory);
      expect(created.code).toBe(0);
      expect(JSON.parse(created.stdout)[field]).toBe("Café 🌿  next");
    }
    const edits = [
      { args: ["project", "edit", "TEXT", "--name"], field: "name" },
      { args: ["project", "column", "edit", "TEXT", " Café 🌿  next ", "--name"], field: "name" },
      { args: ["label", "edit", " Café 🌿  next ", "--name"], field: "name" },
      { args: ["task", "edit", "TEXT-1", "--title"], field: "title" },
    ];
    for (const { args, field } of edits) {
      const edited = runZinn([...args, " Renamed ", "--json"], directory);
      expect(edited.code).toBe(0);
      expect(JSON.parse(edited.stdout)[field]).toBe("Renamed");
    }
    for (const args of [
      ["project", "create", "OTHER", "--name"],
      ["project", "column", "create", "TEXT"],
      ["label", "create"],
      ["task", "create", "TEXT", "--title"],
      ["project", "edit", "TEXT", "--name"],
      ["project", "column", "edit", "TEXT", "Renamed", "--name"],
      ["label", "edit", "Renamed", "--name"],
      ["task", "edit", "TEXT-1", "--title"],
    ]) {
      for (const value of ["\nName", "Name\n", "\tName", "Name\t"]) {
        const invalid = runZinn([...args, value, "--json"], directory);
        expect(invalid.code).toBe(1);
        expect(invalid.stderr).toContain("line breaks or control characters");
      }
    }
  });
});

function runZinnWithConfirmation(args: Array<string>, testDir = TEST_DIR) {
  const proc = Bun.spawnSync(
    ["/bin/sh", "-c", 'printf "y\\n" | exec bun "$@"', "zinn-confirm", CLI_PATH, ...args],
    { env: { ...process.env, ZINN_DIR: testDir } },
  );

  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    code: proc.exitCode,
  };
}

// Unlike runZinn's synchronous subprocess, this lets independent CLI writers overlap.
async function runZinnAsync(args: Array<string>, testDir: string) {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    env: { ...process.env, ZINN_DIR: testDir, AI_AGENT: "concurrency-test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);

  return { code, stdout, stderr };
}

// ? Runs the CLI in a pseudo-terminal, so stdout is a TTY and text output is colored.
// ? stdout and stderr arrive merged, and the terminal's "\r\n" line endings are normalized.
async function runZinnInTerminal(
  args: Array<string>,
  testDir = TEST_DIR,
  additionalEnv: Record<string, string> = {},
  columns = 200,
) {
  const decoder = new TextDecoder();
  const terminalClosed = Promise.withResolvers<void>();
  let output = "";

  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    env: { ...process.env, ...additionalEnv, ZINN_DIR: testDir },
    terminal: {
      cols: columns,
      data: (_terminal, data) => {
        output += decoder.decode(data, { stream: true });
      },
      exit: () => terminalClosed.resolve(),
    },
  });

  const code = await proc.exited;
  await terminalClosed.promise;
  proc.terminal!.close();

  return { output: output.replaceAll("\r\n", "\n"), code };
}

function withTestDb<T>(testDir: string, inspect: (db: Database) => T) {
  const db = new Database(join(testDir, "data", "zinn.sqlite"));
  db.run("PRAGMA foreign_keys = ON;");

  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

// --- ENTRYPOINT

test("bare invocation shows root help and exits zero", () => {
  const result = runZinn([]);

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result).toEqual(runZinn(["--help"]));
});

test("--version and -v print the CLI package version and exit zero", () => {
  withIsolatedZinnDir((testDir) => {
    const longVersion = runZinn(["--version"], testDir);
    const shortVersion = runZinn(["-v"], testDir);

    expect(longVersion.code).toBe(0);
    expect(longVersion.stdout).toBe(`${packageJson.version}\n`);
    expect(longVersion.stderr).toBe("");
    expect(shortVersion).toEqual(longVersion);
  });
});

test("root help supports -h and --help and lists commands", () => {
  const longHelp = runZinn(["--help"]);
  const shortHelp = runZinn(["-h"]);

  expect(longHelp.code).toBe(0);
  expect(longHelp.stdout).toContain("ZINN - A kanban workflow in the terminal");
  expect(longHelp.stdout).toContain("project column {create|list|edit|order}");
  expect(longHelp.stdout).toContain("project {create|list|view|edit|delete}");
  expect(longHelp.stdout).toContain("task {create|list|search|view|edit|move|order|archive|unarchive|delete}");
  expect(longHelp.stdout).toContain("task comment {create|list|edit|delete}");
  expect(longHelp.stdout).toContain("\n  backup\n  restore\n  migrate\n");
  expect(longHelp.stdout).toContain("-v, --version  Show version");
  expect(shortHelp).toEqual(longHelp);
});

// --- ROUTING

test("an unrecognized command exits nonzero", () => {
  const result = runZinn(["task", "destroy", "WIP"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unrecognized command");
});

test("a nested route resolves past its namespace", () => {
  runZinn(["project", "create", "NEST", "--name", "Nested"]);

  // ? `project column list` is three tokens deep; proves the router peels the
  // ? namespace prefix and forwards only "NEST" as the command args.
  const result = runZinn(["project", "column", "list", "NEST"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Backlog");
});

test("namespace help lists its commands without running one", () => {
  const taskHelp = runZinn(["task", "--help"]);
  const projectHelp = runZinn(["project", "-h"]);
  const columnHelp = runZinn(["project", "column", "--help"]);

  expect(taskHelp.code).toBe(0);
  expect(taskHelp.stdout).toContain("Usage: zinn task <command>");
  expect(taskHelp.stdout).toContain(
    "  {create|list|search|view|edit|move|order|archive|unarchive|delete}",
  );
  expect(taskHelp.stdout).toContain("  relation {create|list|delete}");
  expect(taskHelp.stdout).not.toContain("  task ");
  expect(projectHelp.code).toBe(0);
  expect(projectHelp.stdout).toContain("  {create|list|view|edit|delete}");
  expect(projectHelp.stdout).toContain("  column {create|list|edit|order}");
  expect(projectHelp.stdout).not.toContain("  project ");
  expect(columnHelp.code).toBe(0);
  expect(columnHelp.stdout).toContain("Usage: zinn project column <command>");
  expect(columnHelp.stdout).toContain("  {create|list|edit|order}");
  expect(columnHelp.stdout).not.toContain("  column ");
});

const HELP_FLAGS = ["--help", "-h"];
const routeCommands = parseRoutes(routes).map(({ command }) => command);
// ? Every proper prefix of a command's words is a namespace, e.g. "task" and "task comment".
const routeNamespaces = [
  ...new Set(
    routeCommands.flatMap((command) => {
      const words = command.split(" ");
      return words.slice(0, -1).map((_, index) => words.slice(0, index + 1).join(" "));
    }),
  ),
];

const ROOT_USAGE = "Usage: zinn <command>";

test("every command help exits cleanly instead of running the command", () => {
  withIsolatedZinnDir((dir) => {
    // ? ZINN-67: arguments before and after the flag do not change which help prints.
    const argumentsAroundFlag = [
      { before: [], after: [] },
      { before: ["APP-1"], after: ["APP-2", "--json"] },
    ];

    for (const command of routeCommands) {
      for (const flag of HELP_FLAGS) {
        for (const { before, after } of argumentsAroundFlag) {
          const result = runZinn([...command.split(" "), ...before, flag, ...after], dir);
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout).toContain(`Usage: zinn ${command}`);
        }
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 30_000);

test("every namespace help exits cleanly instead of running a command", () => {
  withIsolatedZinnDir((dir) => {
    for (const namespace of routeNamespaces) {
      for (const flag of HELP_FLAGS) {
        // ? ZINN-67: words after the flag are not read, even a known command or a typo.
        for (const after of [[], ["view", "APP-1"], ["shwo"]]) {
          const result = runZinn([...namespace.split(" "), flag, ...after], dir);
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout).toContain(`Usage: zinn ${namespace} <command>`);
        }
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

test("a bare namespace is an error that carries the namespace help", () => {
  withIsolatedZinnDir((dir) => {
    for (const namespace of routeNamespaces) {
      const text = runZinn(namespace.split(" "), dir);
      expect(text.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain(`Usage: zinn ${namespace} <command>`);

      const json = runZinn([...namespace.split(" "), "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      const { error } = JSON.parse(json.stderr);
      expect(typeof error.message).toBe("string");
      expect(error.help).toContain(`Usage: zinn ${namespace} <command>`);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

test("a help flag before command words prints help for the words before it", () => {
  withIsolatedZinnDir((dir) => {
    const rootHelpRequests = [
      ["--help", "task", "view"],
      ["--json", "--help"],
      ["--allow-legacy-read", "--help"],
    ];
    for (const args of rootHelpRequests) {
      const result = runZinn(args, dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(ROOT_USAGE);
    }

    // ? Help stays text under --json.
    const jsonCommandHelp = runZinn(["task", "view", "--json", "--help"], dir);
    expect(jsonCommandHelp.code).toBe(0);
    expect(jsonCommandHelp.stdout).toContain("Usage: zinn task view");
    expect(() => JSON.parse(jsonCommandHelp.stdout)).toThrow();
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

test("an unknown command with a help flag fails with the nearest namespace help on stderr", () => {
  withIsolatedZinnDir((dir) => {
    const cases = [
      { args: ["task", "show", "APP-1", "--help"], usage: "Usage: zinn task <command>" },
      { args: ["task", "relation", "shwo", "-h"], usage: "Usage: zinn task relation <command>" },
      { args: ["bogus", "--help"], usage: ROOT_USAGE },
    ];

    for (const { args, usage } of cases) {
      const text = runZinn(args, dir);
      expect(text.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain(usage);

      const json = runZinn([...args, "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      const { error } = JSON.parse(json.stderr);
      expect(typeof error.message).toBe("string");
      expect(error.help).toContain(usage);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

test("an unknown command without a help flag points to the nearest namespace help", () => {
  withIsolatedZinnDir((dir) => {
    const cases = [
      { args: ["task", "show", "APP-1"], helpCommand: "zinn task --help" },
      { args: ["bogus"], helpCommand: "zinn --help" },
    ];

    for (const { args, helpCommand } of cases) {
      const text = runZinn(args, dir);
      expect(text.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain(helpCommand);
      expect(text.stderr).not.toContain("Usage:");

      const json = runZinn([...args, "--json"], dir);
      expect(json.code).toBe(1);
      const { error } = JSON.parse(json.stderr);
      expect(error.message).toContain(helpCommand);
      expect(error).not.toHaveProperty("help");
    }
  });
});

test("a help flag after command arguments saves nothing", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "APP"], dir);
    const columns = () => withTestDb(dir, (db) => db.query("SELECT * FROM project_column ORDER BY id").all());
    const before = columns();

    const result = runZinn(["project", "column", "create", "APP", "--help"], dir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: zinn project column create");
    expect(columns()).toEqual(before);
  });
});

test("root help and activity namespace help list the activity commands", () => {
  withIsolatedZinnDir((directory) => {
    expect(runZinn(["--help"], directory).stdout).toContain("activity {list|view}");
    expect(runZinn(["activity", "--help"], directory).stdout).toContain("{list|view}");
  });
});

// --- ARGUMENTS

test("every command rejects an unknown option before it opens the database", () => {
  withIsolatedZinnDir((dir) => {
    for (const command of routeCommands) {
      const result = runZinn([...command.split(" "), "--bogus"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--bogus");
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 30_000);

type CommandWords = {
  // ? Words that fill every slot of the usage line, the optional ones included.
  words: string[];
  // ? How many of those words the command requires.
  required: number;
  // ? Whether a word of the usage line repeats (<task-key>...), so no word is one too many.
  repeats?: boolean;
  // ? Flags the command accepts more than once; every other flag is accepted once.
  repeatableFlags?: string[];
};

const commandWords: Record<string, CommandWords> = {
  "project create": { words: ["SHOP"], required: 1 },
  "project list": { words: [], required: 0 },
  "project view": { words: ["SHOP"], required: 1 },
  "project edit": { words: ["SHOP"], required: 1 },
  "project delete": { words: ["SHOP"], required: 1 },
  "project column create": { words: ["SHOP", "Later"], required: 2 },
  "project column list": { words: ["SHOP"], required: 1 },
  "project column edit": { words: ["SHOP", "Later"], required: 2 },
  "project column order": { words: ["SHOP", "TODO", "first"], required: 3 },
  "task create": { words: ["SHOP"], required: 1, repeatableFlags: ["label", "depends-on", "related"] },
  "task list": { words: ["SHOP"], required: 0, repeatableFlags: ["label"] },
  "task search": { words: ["refine", "SHOP"], required: 1, repeatableFlags: ["label"] },
  "task view": { words: ["SHOP-1"], required: 1 },
  "task edit": { words: ["SHOP-1"], required: 1, repeatableFlags: ["add-label", "remove-label"] },
  "task move": { words: ["SHOP-1", "Done"], required: 2, repeats: true },
  "task order": { words: ["SHOP-1", "top"], required: 2 },
  "task archive": { words: ["SHOP-1"], required: 1, repeats: true },
  "task unarchive": { words: ["SHOP-1"], required: 1, repeats: true },
  "task delete": { words: ["SHOP-1"], required: 1 },
  "task relation create": { words: ["SHOP-1", "SHOP-2"], required: 2 },
  "task relation list": { words: ["SHOP-1"], required: 1 },
  "task relation delete": { words: ["SHOP-1", "SHOP-2"], required: 2 },
  "task comment create": { words: ["SHOP-1"], required: 1 },
  "task comment list": { words: ["SHOP-1"], required: 1 },
  "task comment edit": { words: ["SHOP-1#1"], required: 1 },
  "task comment delete": { words: ["SHOP-1#1"], required: 1 },
  "task label add": { words: ["SHOP-1", "bug"], required: 2, repeats: true },
  "task label remove": { words: ["SHOP-1", "bug"], required: 2, repeats: true },
  "label create": { words: ["bug"], required: 1 },
  "label list": { words: [], required: 0 },
  "label edit": { words: ["bug"], required: 1 },
  "label delete": { words: ["bug"], required: 1 },
  "activity list": { words: [], required: 0 },
  "activity view": { words: ["019abcdf"], required: 1 },
  backup: { words: [], required: 0 },
  restore: { words: ["backup.sqlite"], required: 1 },
  migrate: { words: [], required: 0 },
  reindex: { words: [], required: 0 },
};
const EXTRA_WORD = "extra-word";
// ? The usage lines that open each command's help.
const commandUsages = new Map(
  parseRoutes(routes).map(({ command, help }) => [command, help.split("\n\n")[0]!]),
);
// ? A word of a usage line: <name> to fill in, or {a|b} for a choice of literal words.
const USAGE_WORD_PATTERN = /<[^<>\s]+>|\{[^{}\s]+\}/g;
// ? The spellings a word stands for: itself, or each literal word of a choice.
const spellingsOf = (usageWord: string) =>
  usageWord.startsWith("{") ? usageWord.slice(1, -1).split("|") : [usageWord];

test("the table of command words has an entry for every route command and no other", () => {
  expect(Object.keys(commandWords).sort()).toEqual([...routeCommands].sort());
});

test("every command rejects an extra word, naming it with the usage line, before it opens the database", () => {
  withIsolatedZinnDir((dir) => {
    for (const [command, { words, repeats }] of Object.entries(commandWords)) {
      if (repeats) {
        continue;
      }

      const result = runZinn([...command.split(" "), ...words, EXTRA_WORD], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(EXTRA_WORD);
      expect(result.stderr).toContain(`Usage: zinn ${command}`);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("every command with required words rejects one word too few, naming a word its usage line writes", () => {
  withIsolatedZinnDir((dir) => {
    for (const [command, { words, required }] of Object.entries(commandWords)) {
      if (required === 0) {
        continue;
      }

      const result = runZinn([...command.split(" "), ...words.slice(0, required - 1)], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");

      // ? The message is the paragraph before the usage lines. Every word is in the usage lines,
      // ? so a check on all of stderr would pass for any message.
      const [message, usage] = result.stderr.split("\n\n");
      expect(usage).toContain(`Usage: zinn ${command}`);
      const namedWords = message!.match(USAGE_WORD_PATTERN) ?? [];
      expect(namedWords.length).toBeGreaterThan(0);

      const usageSpellings = (usage!.match(USAGE_WORD_PATTERN) ?? []).flatMap(spellingsOf);
      for (const spelling of namedWords.flatMap(spellingsOf)) {
        expect(usageSpellings).toContain(spelling);
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("every flag in a usage line is rejected when given twice, unless the command repeats it", () => {
  withIsolatedZinnDir((dir) => {
    for (const [command, { words, repeatableFlags = [] }] of Object.entries(commandWords)) {
      // ? A flag followed by <...> or {...} takes a value. Any value works, since the repeat check runs first.
      const flags = [...commandUsages.get(command)!.matchAll(/--([a-z-]+)( [<{])?/g)].map(
        ([, name, valueMark]) => ({ name: name!, takesValue: valueMark !== undefined }),
      );
      for (const repeatable of repeatableFlags) {
        expect(flags.map(({ name }) => name)).toContain(repeatable);
      }

      for (const { name, takesValue } of flags) {
        if (repeatableFlags.includes(name)) {
          continue;
        }

        const flag = takesValue ? [`--${name}`, "x"] : [`--${name}`];
        const result = runZinn([...command.split(" "), ...words, ...flag, ...flag], dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`--${name}`);
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("project list, project view, the project column commands, task view and task order reject invalid requests without writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "SHOP"], dir);
    runZinn(["task", "create", "SHOP", "--title", "First"], dir);
    runZinn(["task", "create", "SHOP", "--title", "Second"], dir);
    const read = () => withTestDb(dir, (db) => ({
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    // ? ZINN-51: an unknown option is named; an extra word is named and shown with the usage line;
    // ? a missing word shows the usage line. A -- in front or at the end adds no word, and a second -- is a word.
    type RejectedCases = {
      unknownOption: [string[], string];
      extraWords: Array<[string[], string]>;
      missingWords: Array<string[]>;
    };
    const casesByCommand: Record<string, RejectedCases> = {
      "project list": {
        unknownOption: [["--bogus"], "--bogus"],
        extraWords: [[["extra"], "extra"], [["--", "extra"], "extra"], [["extra", "--"], "extra"], [["--", "--"], "--"]],
        missingWords: [],
      },
      "project view": {
        unknownOption: [["SHOP", "--bogus"], "--bogus"],
        extraWords: [[["SHOP", "extra"], "extra"], [["--", "SHOP", "extra"], "extra"], [["SHOP", "--", "--"], "--"]],
        missingWords: [[], ["--"]],
      },
      "project column create": {
        unknownOption: [["SHOP", "Later", "--bogus"], "--bogus"],
        extraWords: [
          [["SHOP", "Needs", "Review"], "Review"],
          [["--", "SHOP", "Needs", "Review"], "Review"],
          [["SHOP", "Later", "--", "--"], "--"],
        ],
        missingWords: [[], ["SHOP"], ["--", "SHOP"], ["SHOP", "--"]],
      },
      "project column list": {
        unknownOption: [["SHOP", "--counts"], "--counts"],
        extraWords: [[["SHOP", "extra"], "extra"], [["--", "SHOP", "extra"], "extra"], [["SHOP", "--", "--"], "--"]],
        missingWords: [[], ["--"]],
      },
      "project column order": {
        unknownOption: [["SHOP", "TODO", "first", "--foo"], "--foo"],
        extraWords: [
          [["SHOP", "TODO", "first", "Done"], "Done"],
          [["SHOP", "TODO", "before", "Done", "Review"], "Review"],
          [["--", "SHOP", "TODO", "first", "Done"], "Done"],
          [["SHOP", "TODO", "first", "--", "--"], "--"],
        ],
        missingWords: [[], ["SHOP", "TODO"], ["SHOP", "TODO", "before"], ["--", "SHOP", "TODO"], ["SHOP", "TODO", "after", "--"]],
      },
      "task view": {
        unknownOption: [["SHOP-1", "--bogus"], "--bogus"],
        extraWords: [[["SHOP-1", "SHOP-2"], "SHOP-2"], [["--", "SHOP-1", "SHOP-2"], "SHOP-2"], [["SHOP-1", "--", "--"], "--"]],
        missingWords: [[], ["--"]],
      },
      "task order": {
        unknownOption: [["SHOP-1", "--foo"], "--foo"],
        extraWords: [
          [["SHOP-1", "top", "SHOP-2"], "SHOP-2"],
          [["SHOP-1", "before", "SHOP-2", "extra"], "extra"],
          [["--", "SHOP-1", "top", "SHOP-2"], "SHOP-2"],
          [["SHOP-1", "top", "--", "--"], "--"],
        ],
        missingWords: [[], ["SHOP-1"], ["SHOP-1", "before"], ["--", "SHOP-1"], ["SHOP-1", "after", "--"]],
      },
    };

    for (const [command, { unknownOption, extraWords, missingWords }] of Object.entries(casesByCommand)) {
      const usage = `Usage: zinn ${command}`;
      const rejections = [
        { args: unknownOption[0], facts: [unknownOption[1]] },
        ...extraWords.map(([args, word]) => ({ args, facts: [`"${word}"`, usage] })),
        ...missingWords.map((args) => ({ args, facts: [usage] })),
      ];
      for (const { args, facts } of rejections) {
        const result = runZinn([...command.split(" "), ...args], dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        for (const fact of facts) {
          expect(result.stderr).toContain(fact);
        }
        expect(read()).toEqual(before);
      }
    }

    // ? An unknown direction shows both usage lines, so the valid directions are listed.
    for (const args of [["project", "column", "order", "SHOP", "TODO", "sideways"], ["task", "order", "SHOP-1", "sideways"]]) {
      const result = runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`"sideways"`);
      expect(result.stderr).toContain("{before|after}");
      expect(read()).toEqual(before);
    }
  });
}, 30_000);

test("project column create takes a name that begins with a dash only after --", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "SHOP"], dir);
    const readNames = () => withTestDb(dir, (db) =>
      db.query<{ name: string }, []>("SELECT name FROM project_column ORDER BY column_order").all().map(({ name }) => name),
    );
    const before = readNames();

    // ? A flag, a word that begins with a dash and the second half of an unquoted name are never saved as a name.
    for (const args of [["SHOP", "--name", "Waiting"], ["SHOP", "Needs", "Review"], ["SHOP", "-later"]]) {
      const result = runZinn(["project", "column", "create", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(readNames()).toEqual(before);
    }

    expect(runZinn(["project", "column", "create", "SHOP", "--", "-later"], dir).code).toBe(0);
    expect(readNames()).toEqual([...before, "-later"]);
  });
});

test("a -- in front of the words or at the end leaves a valid command working", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "SHOP"], dir);
    runZinn(["task", "create", "SHOP", "--title", "First"], dir);
    runZinn(["task", "create", "SHOP", "--title", "Second"], dir);

    const sameAsWithout: Array<[string[], string[]]> = [
      [["task", "view", "--", "SHOP-1"], ["task", "view", "SHOP-1"]],
      [["project", "view", "SHOP", "--"], ["project", "view", "SHOP"]],
      [["project", "column", "list", "--", "SHOP"], ["project", "column", "list", "SHOP"]],
    ];
    for (const [withSeparator, withoutSeparator] of sameAsWithout) {
      const result = runZinn(withSeparator, dir);
      expect(result.code).toBe(0);
      expect(result).toEqual(runZinn(withoutSeparator, dir));
    }

    expect(runZinn(["task", "order", "SHOP-2", "top", "--"], dir).code).toBe(0);
    expect(runZinn(["task", "list", "SHOP"], dir).stdout).toMatch(/SHOP-2[^\n]*\nSHOP-1/);
  });
});

test("delete commands take one key and one --yes, and delete nothing otherwise", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "A"], dir);
    runZinn(["project", "create", "B"], dir);
    runZinn(["task", "create", "A", "--title", "First"], dir);
    runZinn(["task", "create", "A", "--title", "Second"], dir);
    runZinn(["task", "comment", "create", "A-1", "--text", "Note"], dir);
    runZinn(["label", "create", "bug"], dir);
    const read = () => withTestDb(dir, (db) => ({
      projects: db.query("SELECT * FROM project ORDER BY id").all(),
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      comments: db.query("SELECT * FROM comment ORDER BY id").all(),
      labels: db.query("SELECT * FROM label ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    // ? Each case lists the facts its error carries.
    const cases: Array<[string[], ...string[]]> = [
      [["task", "delete", "A-1", "A-2", "--yes"], `"A-2"`, "Usage: zinn task delete"],
      [["project", "delete", "A", "B", "--yes"], `"B"`, "Usage: zinn project delete"],
      // ? After --, --yes is a word, so it is rejected as an extra word.
      [["task", "delete", "--", "A-1", "--yes"], `"--yes"`, "Usage: zinn task delete"],
      [["task", "delete", "A-1", "--yes", "--", "--"], `"--"`, "Usage: zinn task delete"],
      [["project", "delete", "A", "--yes", "--yes"], "--yes"],
      [["task", "delete", "A-1", "--yes", "--yes"], "--yes"],
      [["task", "comment", "delete", "A-1#1", "--yes", "--yes"], "--yes"],
      [["label", "delete", "bug", "--yes", "--yes"], "--yes"],
    ];
    for (const [args, ...facts] of cases) {
      const result = runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
      expect(read()).toEqual(before);
    }
  });
});

test("--json or --allow-legacy-read given twice runs nothing, while a second help flag still shows help", () => {
  withIsolatedZinnDir((dir) => {
    for (const flag of ["--json", "--allow-legacy-read"]) {
      const result = runZinn(["project", "create", "APP", flag, flag], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(flag);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);

    const help = runZinn(["task", "view", "A-1", "-h", "--help"], dir);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: zinn task view");
  });
});

test("with --json, an extra word is one JSON error on stderr whose help is the usage line", () => {
  withIsolatedZinnDir((dir) => {
    const result = runZinn(["task", "view", "A-1", "A-2", "--json"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const { error } = JSON.parse(result.stderr);
    expect(error.message).toContain("A-2");
    expect(error.help).toContain("Usage: zinn task view");
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

// --- PROJECT

test("project create seeds the default columns", () => {
  expect(runZinn(["project", "create", "WIP", "--name", "Work"]).code).toBe(0);

  const listed = runZinn(["project", "column", "list", "WIP", "--json"]);

  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual([
    { name: "Backlog", taskCount: 0 },
    { name: "TODO", taskCount: 0 },
    { name: "In Progress", taskCount: 0 },
    { name: "Review", taskCount: 0 },
    { name: "Done", taskCount: 0 },
  ]);
});

test("project create requires a key", () => {
  const result = runZinn(["project", "create"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Usage: zinn project create");
});

test("project create defaults the stored name to the uppercase key and allows a later rename", () => {
  withIsolatedZinnDir((testDir) => {
    const created = runZinn(["project", "create", "site"], testDir);

    expect(created.code).toBe(0);
    expect(created.stdout).toBe("SITE | SITE\n");
    withTestDb(testDir, (db) => {
      expect(db.query("SELECT key, name FROM project").get()).toEqual({
        key: "SITE",
        name: "SITE",
      });
    });

    const edited = runZinn(["project", "edit", "SITE", "--name", "Website refresh"], testDir);
    expect(edited.code).toBe(0);
    expect(runZinn(["project", "list"], testDir).stdout).toBe("SITE | Website refresh\n");
  });
});

test("project create rejects extra positionals and invalid name flags", () => {
  withIsolatedZinnDir((testDir) => {
    for (const args of [
      ["SITE", "Website"],
      ["SITE", "--name"],
      ["SITE", "--name", "First", "--name", "Second"],
      ["SITE", "--title", "Website"],
    ]) {
      expect(runZinn(["project", "create", ...args], testDir).code).toBe(1);
    }
    expect(runZinn(["project", "list"], testDir).stdout).toBe("");
  });
});

test("project create rejects a duplicate key regardless of casing", () => {
  expect(runZinn(["project", "create", "DUP", "--name", "First"]).code).toBe(0);

  const second = runZinn(["project", "create", "dup", "--name", "Second"]);

  expect(second.code).toBe(1);
  expect(second.stderr).toContain(`Project with key "DUP" already exists!`);
});

test("project column create rejects a duplicate name regardless of casing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], testDir);
    expect(runZinn(["project", "column", "create", "COL", "Later"], testDir).code).toBe(0);

    const duplicate = runZinn(["project", "column", "create", "COL", "later"], testDir);

    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain(
      `There is already a "later" column`,
    );
    withTestDb(testDir, (db) => {
      const matches = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM project_column WHERE project_id = (SELECT id FROM project WHERE key = 'COL') AND LOWER(name) = 'later'",
        )
        .get();

      expect(matches?.count).toBe(1);
    });
  });
});

test("project column create trims names and rejects invalid ones without writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project_column").all());
    const before = read();
    for (const [name, message] of [
      [" done ", `There is already a "done" column`],
      ["   ", "Column name cannot be blank"],
      ["Next\nDone", "Column name cannot contain line breaks or control characters"],
    ]) {
      const result = runZinn(["project", "column", "create", "COL", name!], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message!);
      expect(read()).toEqual(before);
    }

    expect(runZinn(["project", "column", "create", "COL", " Later "], dir).stdout).toBe("COL | Later\n");
  });
});

test("project column names are unique only within a project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    runZinn(["project", "create", "BETA", "--name", "Beta"], testDir);

    const alpha = runZinn(["project", "column", "create", "ALPHA", "QA"], testDir);
    const beta = runZinn(["project", "column", "create", "BETA", "qa"], testDir);

    expect(alpha.code).toBe(0);
    expect(beta.code).toBe(0);
  });
});

test("project column edit renames a column in place and keeps its tasks", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    runZinn(["task", "create", "COL", "--title", "Stays put"], dir);
    runZinn(["task", "move", "COL-1", "todo"], dir);
    const readColumns = () =>
      withTestDb(dir, (db) => db.query("SELECT * FROM project_column ORDER BY column_order").all());
    const before = readColumns();

    const renamed = runZinn(["project", "column", "edit", "col", "todo", "--name", " Next up "], dir);
    expect(renamed).toEqual({ stdout: "COL | Next up\n", stderr: "", code: 0 });
    expect(runZinn(["project", "column", "list", "COL"], dir).stdout).toBe(
      "Backlog     | 0\nNext up     | 1\nIn Progress | 0\nReview      | 0\nDone        | 0\n",
    );
    expect(readColumns()).toEqual(
      before.map((row: any) => (row.name === "TODO" ? { ...row, name: "Next up" } : row)),
    );
    expect(runZinn(["task", "view", "COL-1", "--json"], dir).stdout).toContain(`"column": "Next up"`);

    const caseOnly = runZinn(["project", "column", "edit", "COL", "next up", "--name", "NEXT UP", "--json"], dir);
    expect(JSON.parse(caseOnly.stdout)).toEqual({ project: "COL", name: "NEXT UP" });
    expect(runZinn(["project", "column", "edit", "COL", "--name=--example", "NEXT UP"], dir).stdout).toBe(
      "COL | --example\n",
    );
  });
});

test("project column edit rejects invalid requests without writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project_column").all());
    const before = read();
    const usage = "Usage: zinn project column edit";
    // ? Each case lists the facts its error carries.
    const cases: Array<[string[], ...string[]]> = [
      [[], usage],
      [["COL"], usage],
      [["COL", "TODO", "extra", "--name", "Next"], `"extra"`, usage],
      [["COL", "TODO"], "Provide an edit flag: --name"],
      [["COL", "TODO", "--name"], "argument missing"],
      [["COL", "TODO", "--title", "Next"], "Unknown option"],
      [["COL", "TODO", "--name", "One", "--name", "Two"], "only be specified once"],
      [["COL", "TODO", "--name", "   "], "Column name cannot be blank"],
      [["COL", "TODO", "--name", "Next\nDone"], "Column name cannot contain line breaks or control characters"],
      [["COL", "TODO", "--name", "done"], `There is already a "done" column`],
      [["COL", "Missing", "--name", "Next"], `Columns does not have a column named "Missing"`],
      [["NOPE", "TODO", "--name", "Next"], `Project with key "NOPE" does not exist!`],
    ];
    for (const [args, ...facts] of cases) {
      const result = runZinn(["project", "column", "edit", ...args], dir);
      expect(result.code).toBe(1);
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
      expect(result.stdout).toBe("");
      expect(read()).toEqual(before);
    }

    const unchanged = runZinn(["project", "column", "edit", "COL", "todo", "--name", "TODO"], dir);
    expect(unchanged).toEqual({ stdout: "COL | TODO\n", stderr: "", code: 0 });
    expect(read()).toEqual(before);
  });
});

test("project column order moves a column in every direction and prints it", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const listColumns = () => JSON.parse(
      runZinn(["project", "column", "list", "COL", "--json"], dir).stdout,
    ).map((column: { name: string }) => column.name);

    expect(runZinn(["project", "column", "order", "col", "review", "first"], dir)).toEqual({
      stdout: "COL | Review\n",
      stderr: "",
      code: 0,
    });
    expect(listColumns()).toEqual(["Review", "Backlog", "TODO", "In Progress", "Done"]);

    const steps: Array<[string[], string[]]> = [
      [["Review", "next"], ["Backlog", "Review", "TODO", "In Progress", "Done"]],
      [["Review", "last"], ["Backlog", "TODO", "In Progress", "Done", "Review"]],
      [["Review", "previous"], ["Backlog", "TODO", "In Progress", "Review", "Done"]],
      [["todo", "after", "DONE"], ["Backlog", "In Progress", "Review", "Done", "TODO"]],
      [["todo", "before", "in progress"], ["Backlog", "TODO", "In Progress", "Review", "Done"]],
    ];
    for (const [args, expected] of steps) {
      expect(runZinn(["project", "column", "order", "COL", ...args], dir).code).toBe(0);
      expect(listColumns()).toEqual(expected);
    }

    const json = runZinn(["project", "column", "order", "COL", "done", "first", "--json"], dir);
    expect(JSON.parse(json.stdout)).toEqual({ project: "COL", name: "Done" });
  });
});

test("project column order rejects invalid requests and skips no-ops without writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project_column").all());
    const before = read();
    const usage = "Usage: zinn project column order";
    // ? Each case lists the facts its error carries.
    const cases: Array<[string[], ...string[]]> = [
      [[], usage],
      [["COL"], usage],
      [["COL", "TODO"], usage],
      [["COL", "TODO", "sideways"], `Unknown order direction "sideways"`],
      [["COL", "TODO", "top"], `Unknown order direction "top"`],
      [["COL", "TODO", "before"], usage],
      [["COL", "TODO", "before", "Done", "Review"], `"Review"`, usage],
      [["COL", "TODO", "first", "Done"], `"Done"`, usage],
      [["COL", "   ", "first"], "Column name cannot be blank"],
      [["COL", "Missing", "first"], `Columns does not have a column named "Missing"`],
      [["COL", "TODO", "after", "Missing"], `Columns does not have a column named "Missing"`],
      [["NOPE", "TODO", "first"], `Project with key "NOPE" does not exist!`],
    ];
    for (const [args, ...facts] of cases) {
      const result = runZinn(["project", "column", "order", ...args], dir);
      expect(result.code).toBe(1);
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
      expect(result.stdout).toBe("");
      expect(read()).toEqual(before);
    }

    for (const args of [["backlog", "first"], ["Done", "next"], ["TODO", "after", "backlog"], ["TODO", "before", "todo"]]) {
      const unchanged = runZinn(["project", "column", "order", "COL", ...args], dir);
      expect(unchanged.code).toBe(0);
      expect(unchanged.stderr).toBe("");
      expect(read()).toEqual(before);
    }
  });
});

test("project delete accepts a non-standardized key and removes its columns and tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "GONE", "--name", "Doomed"], testDir);
    runZinn(["task", "create", "GONE", "--title", "Doomed task"], testDir);
    runZinn(["project", "create", "KEEP", "--name", "Kept"], testDir);
    runZinn(["task", "create", "KEEP", "--title", "Kept task"], testDir);

    expect(
      runZinnWithConfirmation(["project", "delete", "gone"], testDir).code,
    ).toBe(0);

    withTestDb(testDir, (db) => {
      expect(db.query("SELECT * FROM project WHERE key = 'GONE'").get()).toBeNull();
      expect(
        db
          .query("SELECT * FROM project_column WHERE project_id NOT IN (SELECT id FROM project)")
          .all(),
      ).toEqual([]);
      expect(
        db.query("SELECT * FROM task WHERE project_id NOT IN (SELECT id FROM project)").all(),
      ).toEqual([]);
      expect(db.query("SELECT * FROM project WHERE key = 'KEEP'").get()).not.toBeNull();
      expect(db.query("SELECT * FROM task WHERE title = 'Kept task'").get()).not.toBeNull();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});

test("project delete keeps the project when confirmation is declined", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KEEP", "--name", "Kept"], testDir);
    runZinn(["task", "create", "KEEP", "--title", "Kept task"], testDir);

    const result = runZinn(["project", "delete", "keep"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Deletion cancelled for KEEP | Kept");
    expect(runZinn(["project", "list"], testDir).stdout).toContain("KEEP | Kept");
    expect(runZinn(["task", "list", "KEEP"], testDir).stdout).toContain("Kept task");
  });
});

test("project delete rejects an unknown key", () => {
  const result = runZinn(["project", "delete", "NOSUCH"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`Project with key "NOSUCH" does not exist!`);
});

test("project list on an empty database exits cleanly without inventing a row", () => {
  withIsolatedZinnDir((testDir) => {
    const result = runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("project list renders every project once and aligns unequal key widths", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["project", "create", "a", "--name", "Short"], testDir).code).toBe(0);
    expect(runZinn(["project", "create", "LONGKEY", "--name", "Long"], testDir).code).toBe(0);

    const result = runZinn(["project", "list"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines).toHaveLength(2);
    expect(lines).toContain("A       | Short");
    expect(lines).toContain("LONGKEY | Long");
  });
});

test("project list does not retain a deleted project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    runZinn(["project", "create", "REMOVE", "--name", "Remove"], testDir);
    expect(
      runZinnWithConfirmation(["project", "delete", "REMOVE"], testDir).code,
    ).toBe(0);

    const result = runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("KEEP");
    expect(result.stdout).not.toContain("REMOVE");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

test("project view prints the full description and unarchived task counts per column, with archived tasks as one total", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const description = "Refine the numbers\n  Keep the quota";
    run("project", "create", "VIEW", "--name", "Project view", "--description", description);
    run("project", "create", "OTHER");
    run("task", "create", "OTHER", "--title", "Elsewhere");
    for (const title of ["Backlog task", "First done", "Second done", "Archived task"]) {
      run("task", "create", "VIEW", "--title", title, "--description", "Task description");
    }
    run("task", "move", "VIEW-2", "VIEW-3", "Done");
    run("task", "archive", "VIEW-4");

    const viewedProject = run("project", "view", "view");

    expect(viewedProject.code).toBe(0);
    expect(viewedProject.stderr).toBe("");
    expect(viewedProject.stdout).toBe(
      [
        "VIEW | Project view",
        "",
        "Description:",
        "Refine the numbers",
        "  Keep the quota",
        "",
        "Columns:",
        "Backlog     | 1",
        "TODO        | 0",
        "In Progress | 0",
        "Review      | 0",
        "Done        | 2",
        "Archived    | 1",
        "",
      ].join("\n"),
    );
  });
});

test("project view leaves out the Description section and Archived row when there is nothing to show", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EMPTY", "--name", "Empty project"], testDir);

    expect(runZinn(["project", "view", "EMPTY"], testDir).stdout).toBe(
      [
        "EMPTY | Empty project",
        "",
        "Columns:",
        "Backlog     | 0",
        "TODO        | 0",
        "In Progress | 0",
        "Review      | 0",
        "Done        | 0",
        "",
      ].join("\n"),
    );
  });
});

test("project view JSON contains the project, per-column task counts in board order and the archived total", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    run("project", "create", "VIEW", "--name", "Project view", "--description", "Full\ndescription");
    run("task", "create", "VIEW", "--title", "Visible task");
    run("task", "create", "VIEW", "--title", "Review task");
    run("task", "move", "VIEW-2", "Review");
    run("project", "column", "order", "VIEW", "Review", "first");

    const expectedColumns = [
      { name: "Review", taskCount: 1 },
      { name: "Backlog", taskCount: 1 },
      { name: "TODO", taskCount: 0 },
      { name: "In Progress", taskCount: 0 },
      { name: "Done", taskCount: 0 },
    ];
    const viewedProject = run("project", "view", "VIEW", "--json");

    expect(viewedProject.code).toBe(0);
    expect(JSON.parse(viewedProject.stdout)).toEqual({
      key: "VIEW",
      name: "Project view",
      description: "Full\ndescription",
      columns: expectedColumns,
      archivedTaskCount: 0,
    });
    expect(JSON.parse(run("project", "column", "list", "view", "--json").stdout)).toEqual(expectedColumns);

    run("task", "archive", "VIEW-1");
    expect(JSON.parse(run("project", "view", "VIEW", "--json").stdout)).toMatchObject({
      columns: [expectedColumns[0], { name: "Backlog", taskCount: 0 }, ...expectedColumns.slice(2)],
      archivedTaskCount: 1,
    });
    expect(JSON.parse(run("project", "column", "list", "VIEW", "--json").stdout)).toEqual([
      expectedColumns[0], { name: "Backlog", taskCount: 0 }, ...expectedColumns.slice(2),
    ]);
  });
});

test("project view validates its project key", () => {
  withIsolatedZinnDir((testDir) => {
    const missing = runZinn(["project", "view"], testDir);
    const extra = runZinn(["project", "view", "ONE", "TWO"], testDir);
    const unknown = runZinn(["project", "view", "unknown"], testDir);

    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Usage: zinn project view");
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain(`"TWO"`);
    expect(extra.stderr).toContain("Usage: zinn project view");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Project with key "UNKNOWN" does not exist!');
  });
});

test("project create accepts an alphanumeric key in any casing and stores it uppercase", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["project", "create", "b2B", "--name", "Business"], testDir).code).toBe(0);

    const result = runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("B2B | Business\n");
  });
});

test("project create rejects keys outside the alphanumeric contract", () => {
  withIsolatedZinnDir((testDir) => {
    for (const invalidKey of ["2B", "APP-DEV", "APP_DEV", "ÅPP", ""]) {
      const result = runZinn(["project", "create", invalidKey, "--name", "Invalid"], testDir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "Project key must start with a letter and contain only letters and numbers",
      );
    }
  });
});

test("project create rejects blank or non-single-line names", () => {
  withIsolatedZinnDir((testDir) => {
    for (const invalidName of ["", "   ", "first line\nsecond line", "name\u001b[31m"]) {
      const result = runZinn(["project", "create", "SAFE", "--name", invalidName], testDir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Project name cannot be blank or contain line breaks or control characters");
    }
  });
});

// --- TASK

test("task create rejects an unknown project", () => {
  const result = runZinn(["task", "create", "NOPE", "--title", "orphan task"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`Project with key "NOPE" does not exist`);
});

test("task create requires a project key and a title", () => {
  runZinn(["project", "create", "ARGS", "--name", "Args"]);

  expect(runZinn(["task", "create"]).stderr).toContain("Usage: zinn task create");
  expect(runZinn(["task", "create", "ARGS"]).stderr).toContain("A task needs at least a title");
});

test("task create succeeds against an existing project", () => {
  runZinn(["project", "create", "TSK", "--name", "Tasks"]);

  const result = runZinn(["task", "create", "TSK", "--title", "first task"]);

  // The placement contract is asserted independently below.
  expect(result.code).toBe(0);
});

test("task create attaches the task to its project's first ordered column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "PLACE", "--name", "Placed"], testDir);
    runZinn(["project", "column", "create", "PLACE", "Later"], testDir);

    expect(runZinn(["task", "create", "PLACE", "--title", "placed task"], testDir).code).toBe(0);

    withTestDb(testDir, (db) => {
      const taskRow = db
        .query<
          { project_id: string; column_id: string },
          []
        >("SELECT project_id, column_id FROM task WHERE title = 'placed task'")
        .get();
      const firstColumn = db
        .query<
          { id: string; project_id: string; name: string },
          []
        >("SELECT id, project_id, name FROM project_column ORDER BY column_order LIMIT 1")
        .get();

      expect(taskRow).not.toBeNull();
      expect(firstColumn).not.toBeNull();
      expect(firstColumn?.name).toBe("Backlog");
      expect(taskRow?.column_id).toBe(firstColumn?.id);
      expect(taskRow?.project_id).toBe(firstColumn?.project_id);
    });
  });
});

test("task create --column places the task last in the named column, matched case-insensitively", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "COLS", "--name", "Columns"], testDir);

    const first = runZinn(["task", "create", "COLS", "--title", "first", "--column", "in progress"], testDir);
    const second = runZinn(["task", "create", "COLS", "--title", "second", "--column", "IN PROGRESS"], testDir);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain("COLS-1 | In Progress | - | first");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("COLS-2 | In Progress | - | second");

    withTestDb(testDir, (db) => {
      const titles = db
        .query<{ title: string }, []>("SELECT title FROM task ORDER BY task_order")
        .all()
        .map((row) => row.title);

      expect(titles).toEqual(["first", "second"]);
    });
  });
});

test("task create --column rejects an unknown column and creates nothing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "BADCOL", "--name", "Bad column"], testDir);

    const rejected = runZinn(["task", "create", "BADCOL", "--title", "nowhere", "--column", "Nowhere"], testDir);
    const repeated = runZinn(
      ["task", "create", "BADCOL", "--title", "twice", "--column", "Done", "--column", "TODO"],
      testDir,
    );

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Bad column does not have a column named "Nowhere"');
    expect(repeated.code).toBe(1);
    expect(repeated.stderr).toContain('Option "--column" can only be specified once');
    expect(runZinn(["task", "list", "BADCOL"], testDir).stdout).toBe("");
    expect(runZinn(["task", "create", "BADCOL", "--title", "real"], testDir).stdout).toContain(
      "BADCOL-1 | Backlog | - | real",
    );
  });
});

test("task create relation flags relate the new task to existing tasks, from the new task's side", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: string[]) => runZinn(args, testDir);
    run("project", "create", "APP", "--name", "App");
    run("project", "create", "OTHER", "--name", "Other");
    for (const title of ["Epic", "Prerequisite", "Sibling", "Original"]) {
      run("task", "create", "APP", "--title", title);
    }
    run("task", "create", "OTHER", "--title", "Elsewhere");

    const created = run(
      "task", "create", "APP", "--title", "Child",
      "--parent", "app-1", "--depends-on", "APP-2", "--depends-on", "OTHER-1",
      "--duplicate-of", "APP-4", "--related", "APP-3",
    );

    expect(created.code).toBe(0);
    expect(created.stdout).toBe("APP-5 | Backlog | - | Child\n");

    const childRelations = run("task", "relation", "list", "APP-5").stdout;
    expect(childRelations).toMatch(/Parent\s+\|\s+APP-1\s+\|\s+Backlog\s+\|\s+Epic/);
    expect(childRelations).toMatch(/Depends on\s+\|\s+APP-2\s+\|\s+Backlog\s+\|\s+Prerequisite/);
    expect(childRelations).toMatch(/Depends on\s+\|\s+OTHER-1\s+\|\s+Backlog\s+\|\s+Elsewhere/);
    expect(childRelations).toMatch(/Duplicate of\s+\|\s+APP-4\s+\|\s+Backlog\s+\|\s+Original/);
    expect(childRelations).toMatch(/Related to\s+\|\s+APP-3\s+\|\s+Backlog\s+\|\s+Sibling/);
    expect(run("task", "relation", "list", "APP-1").stdout).toMatch(/Subtask\s+\|\s+APP-5\s+\|\s+Backlog\s+\|\s+Child/);
    expect(run("task", "relation", "list", "APP-2").stdout).toMatch(/Depended on by\s+\|\s+APP-5\s+\|\s+Backlog\s+\|\s+Child/);
    expect(run("task", "relation", "list", "APP-4").stdout).toMatch(/Duplicated by\s+\|\s+APP-5\s+\|\s+Backlog\s+\|\s+Child/);
    expect(run("task", "view", "APP-5").stdout).toMatch(/Parent\s+\|\s+APP-1\s+\|\s+Backlog\s+\|\s+Epic/);

    withTestDb(testDir, (db) => {
      const actionsOf = (key: string) =>
        db
          .query<{ action: string }, [string]>(
            `SELECT activity.action FROM activity
             JOIN task ON task.id = activity.entity_id
             JOIN project ON project.id = task.project_id
             WHERE activity.entity_type = 'task' AND project.key || '-' || task.number = ?
             ORDER BY activity.id`,
          )
          .all(key)
          .map((row) => row.action);

      expect(actionsOf("APP-5")).toEqual([
        "create", "relation_create", "relation_create", "relation_create", "relation_create", "relation_create",
      ]);
      expect(actionsOf("APP-1")).toEqual(["create", "relation_create"]);
      expect(actionsOf("OTHER-1")).toEqual(["create", "relation_create"]);
    });
  });
});

test("task create counts a repeated relation target once and keeps different relation types to it", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: string[]) => runZinn(args, testDir);
    run("project", "create", "APP", "--name", "App");
    run("task", "create", "APP", "--title", "Target");

    const created = run(
      "task", "create", "APP", "--title", "Source",
      "--depends-on", "APP-1", "--depends-on", "app-1", "--related", "APP-1", "--related", "APP-1",
    );
    const relations = run("task", "relation", "list", "APP-2").stdout.trimEnd().split("\n");

    expect(created.code).toBe(0);
    expect(relations).toHaveLength(2);
    expect(relations[0]).toMatch(/Depends on\s+\|\s+APP-1\s+\|\s+Backlog\s+\|\s+Target/);
    expect(relations[1]).toMatch(/Related to\s+\|\s+APP-1\s+\|\s+Backlog\s+\|\s+Target/);
  });
});

test("task create rejects a missing, malformed or repeated relation target and creates nothing", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: string[]) => runZinn(args, testDir);
    run("project", "create", "APP", "--name", "App");
    run("task", "create", "APP", "--title", "Epic");
    run("task", "create", "APP", "--title", "Other epic");
    const countRows = () =>
      withTestDb(testDir, (db) =>
        db
          .query(
            "SELECT (SELECT COUNT(*) FROM task) AS tasks, (SELECT COUNT(*) FROM activity) AS activities, (SELECT COUNT(*) FROM task_relations) AS relations",
          )
          .get(),
      );
    const before = countRows();

    const missing = run("task", "create", "APP", "--title", "Lost", "--parent", "APP-1", "--depends-on", "APP-99");
    const missingProject = run("task", "create", "APP", "--title", "Lost", "--related", "NOPE-1");
    const malformed = run("task", "create", "APP", "--title", "Lost", "--depends-on", "APP-1", "--related", "nope");
    const secondParent = run("task", "create", "APP", "--title", "Lost", "--parent", "APP-1", "--parent", "APP-2");
    const secondDuplicate = run("task", "create", "APP", "--title", "Lost", "--duplicate-of", "APP-1", "--duplicate-of", "APP-2");

    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Task "APP-99" does not exist');
    expect(missingProject.code).toBe(1);
    expect(missingProject.stderr).toContain('Project with key "NOPE" does not exist');
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain('Invalid task key "nope"');
    expect(secondParent.code).toBe(1);
    expect(secondParent.stderr).toContain('Option "--parent" can only be specified once');
    expect(secondDuplicate.code).toBe(1);
    expect(secondDuplicate.stderr).toContain('Option "--duplicate-of" can only be specified once');
    expect(countRows()).toEqual(before);
    expect(run("task", "create", "APP", "--title", "Real").stdout).toBe("APP-3 | Backlog | - | Real\n");
  });
});

test("task create help lists the relation flags", () => {
  const help = runZinn(["task", "create", "--help"]);

  expect(help.code).toBe(0);
  for (const flag of ["--parent <task-key>", "--depends-on <task-key>", "--duplicate-of <task-key>", "--related <task-key>"]) {
    expect(help.stdout).toContain(flag);
  }
});

test("task ordering starts independently in each column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    runZinn(["task", "create", "ALPHA", "--title", "todo first"], testDir);

    withTestDb(testDir, (db) => {
      const todoColumn = db
        .query<{ id: string }, []>("SELECT id FROM project_column WHERE name = 'TODO'")
        .get();

      expect(todoColumn).not.toBeNull();
      db.run("UPDATE task SET column_id = ? WHERE title = 'todo first'", [todoColumn!.id]);
    });

    runZinn(["task", "create", "ALPHA", "--title", "backlog first"], testDir);
    runZinn(["task", "create", "ALPHA", "--title", "backlog second"], testDir);

    withTestDb(testDir, (db) => {
      const rows = db
        .query<{ title: string; task_order: string }, []>(
          "SELECT title, task_order FROM task ORDER BY title",
        )
        .all();

      expect(rows).toHaveLength(3);
      expect(rows[0]?.task_order).toBe(rows[2]?.task_order);
      expect(rows[1]!.task_order > rows[0]!.task_order).toBe(true);
    });
  });
});

test("a project without columns rejects task creation without consuming a task number", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EMPTYCOL", "--name", "No columns"], testDir);
    withTestDb(testDir, (db) => db.run("DELETE FROM project_column"));

    const rejected = runZinn(["task", "create", "EMPTYCOL", "--title", "cannot place me"], testDir);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Project "EMPTYCOL" does not have any columns');

    runZinn(["project", "column", "create", "EMPTYCOL", "Inbox"], testDir);
    expect(runZinn(["task", "create", "EMPTYCOL", "--title", "first real task"], testDir).code).toBe(0);
    expect(runZinn(["task", "view", "EMPTYCOL-1"], testDir).stdout).toContain(
      "EMPTYCOL-1 | Inbox | - | first real task",
    );
  });
});

test("task list on an empty database exits cleanly without output", () => {
  withIsolatedZinnDir((testDir) => {
    const result = runZinn(["task", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("task list --column filters project and global results with labels and archive flags", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const keys = (...args: Array<string>) => {
      const result = run("task", "list", ...args, "--json");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout).map((row: { key: string }) => row.key);
    };
    expect(run("project", "create", "AAA").code).toBe(0);
    expect(run("project", "create", "BBB").code).toBe(0);
    expect(run("label", "create", "CLI").code).toBe(0);
    expect(run("label", "create", "Groom").code).toBe(0);
    expect(run("task", "create", "AAA", "--title", "Both", "--column", "In Progress", "--label", "CLI", "--label", "Groom").code).toBe(0);
    expect(run("task", "create", "AAA", "--title", "CLI only", "--column", "In Progress", "--label", "CLI").code).toBe(0);
    expect(run("task", "create", "AAA", "--title", "Elsewhere", "--label", "CLI", "--label", "Groom").code).toBe(0);
    expect(run("task", "create", "BBB", "--title", "Archived", "--column", "In Progress", "--label", "CLI", "--label", "Groom").code).toBe(0);
    expect(run("task", "archive", "BBB-1").code).toBe(0);

    expect(keys("--column", "IN PROGRESS")).toEqual(["AAA-1", "AAA-2"]);
    expect(keys("AAA", "--column", "in progress", "--label", "cli", "--label", "GROOM")).toEqual(["AAA-1"]);
    expect(keys("--column", "In Progress", "--archived", "--label", "CLI", "--label", "Groom")).toEqual(["BBB-1"]);
    expect(keys("--column", "In Progress", "--all", "--label", "CLI", "--label", "Groom")).toEqual(["AAA-1", "BBB-1"]);
    const unfiltered = JSON.parse(run("task", "list", "--all", "--json").stdout);
    const filtered = JSON.parse(run("task", "list", "--column", "In Progress", "--all", "--json").stdout);
    expect(filtered).toEqual(unfiltered.filter((row: { column: string }) => row.column === "In Progress"));
    const text = run("task", "list", "AAA", "--column", "In Progress");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("AAA-1");
    expect(text.stdout).toContain("AAA-2");
    expect(text.stdout).not.toContain("AAA-3");

    for (const scope of [[], ["AAA"]]) {
      for (const name of ["Nowhere", "Review", "Progress"]) {
        expect(keys(...scope, "--column", name)).toEqual([]);
        expect(run("task", "list", ...scope, "--column", name)).toEqual({ stdout: "", stderr: "", code: 0 });
      }
    }
    const repeated = run("task", "list", "--column", "Review", "--column", "Done");
    expect(repeated.code).toBe(1);
    expect(repeated.stderr).toContain('Option "--column" can only be specified once');
    expect(run("task", "list", "--help").stdout).toContain("[--column <name>]");
  });
});

test("task list renders every project's tasks once and aligns unequal key widths", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "a", "--name", "Short"], testDir);
    runZinn(["project", "create", "LONGKEY", "--name", "Long"], testDir);
    runZinn(["task", "create", "A", "--title", "short task", "--description", "short description"], testDir);
    runZinn(["task", "create", "LONGKEY", "--title", "long task", "--description", "long description"], testDir);

    const result = runZinn(["task", "list"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines).toHaveLength(2);
    expect(lines).toContain(`A-1       | Backlog | - | short task`);
    expect(lines).toContain(
      `LONGKEY-1 | Backlog | - | long task`,
    );
  });
});

test("task list does not print a missing description as data", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "NONE", "--name", "No description"], testDir);
    runZinn(["task", "create", "NONE", "--title", "title only"], testDir);

    const result = runZinn(["task", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`NONE-1 | Backlog | - | title only`);
    expect(result.stdout).not.toContain("null");
  });
});

test("task list leaves a long multi-line description to task view, which prints it in full", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "PREVIEW", "--name", "Description preview"], testDir);
    const description = `${"A".repeat(40)}\n\t${"B".repeat(50)}`;

    runZinn(
      ["task", "create", "PREVIEW", "--title", "long description", "--description", description],
      testDir,
    );

    const listResult = runZinn(["task", "list", "PREVIEW"], testDir);
    const viewResult = runZinn(["task", "view", "PREVIEW-1"], testDir);

    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toBe(`PREVIEW-1 | Backlog | - | long description\n`);
    expect(viewResult.code).toBe(0);
    expect(viewResult.stdout).toBe(
      `PREVIEW-1 | Backlog | - | long description\n\n${SECTION_RULE}\nDescription:\n${description}\n`,
    );
  });
});

test("task rows in lists and bulk archive output leave descriptions out, while JSON keeps them", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const descriptions = ["First hidden description", "Second hidden description"];
    run("project", "create", "ROWS");
    run("task", "create", "ROWS", "--title", "First", "--description", descriptions[0]!);
    run("task", "create", "ROWS", "--title", "Second", "--description", descriptions[1]!);

    const rowOutputs = [
      run("task", "list", "ROWS"),
      run("task", "archive", "ROWS-1", "ROWS-2"),
      run("task", "list", "ROWS", "--all"),
      run("task", "unarchive", "ROWS-1", "ROWS-2"),
    ];

    for (const rowOutput of rowOutputs) {
      expect(rowOutput.code).toBe(0);
      expect(rowOutput.stdout).toContain("ROWS-1");
      expect(rowOutput.stdout).not.toContain("hidden description");
    }

    const listedJson = JSON.parse(run("task", "list", "ROWS", "--json").stdout);
    const archivedJson = JSON.parse(run("task", "archive", "ROWS-1", "ROWS-2", "--json").stdout);
    expect(listedJson.map((entry: { description: string }) => entry.description)).toEqual(descriptions);
    expect(archivedJson.map((entry: { description: string }) => entry.description)).toEqual(descriptions);
  });
});

test("task list filters to the requested project regardless of key casing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    runZinn(["project", "create", "BETA", "--name", "Beta"], testDir);
    runZinn(["task", "create", "ALPHA", "--title", "alpha task"], testDir);
    runZinn(["task", "create", "BETA", "--title", "beta task"], testDir);

    const result = runZinn(["task", "list", "aLpHa"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`ALPHA-1 | Backlog | - | alpha task`);
    expect(result.stdout).not.toContain("beta task");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

test("project-scoped task list aligns column names and follows board order", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ORDER", "--name", "Ordered"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "todo first"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "backlog first"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "in progress"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "todo second"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "backlog second"], testDir);

    runZinn(["task", "move", "ORDER-1", "TODO"], testDir);
    runZinn(["task", "move", "ORDER-3", "In Progress"], testDir);
    runZinn(["task", "move", "ORDER-4", "TODO"], testDir);

    const result = runZinn(["task", "list", "ORDER"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "ORDER-2 | Backlog     | - | backlog first",
        "ORDER-5 | Backlog     | - | backlog second",
        "ORDER-1 | TODO        | - | todo first",
        "ORDER-4 | TODO        | - | todo second",
        "ORDER-3 | In Progress | - | in progress",
        "",
      ].join("\n"),
    );
  });
});

test("task list for an empty project does not leak another project's tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EMPTY", "--name", "Empty"], testDir);
    runZinn(["project", "create", "BUSY", "--name", "Busy"], testDir);
    runZinn(["task", "create", "BUSY", "--title", "private task"], testDir);

    const result = runZinn(["task", "list", "EMPTY"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("task list rejects an unknown project", () => {
  withIsolatedZinnDir((testDir) => {
    const result = runZinn(["task", "list", "NOSUCH"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Project with key "NOSUCH" does not exist!`);
  });
});

test("task list and search filter by every repeated label", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    run("project", "create", "FILTER");
    run("label", "create", "CLI");
    run("label", "create", "Groom");
    run("task", "create", "FILTER", "--title", "Both labels", "--label", "CLI", "--label", "Groom");
    run("task", "create", "FILTER", "--title", "CLI only", "--label", "CLI");
    run("task", "create", "FILTER", "--title", "Groom only", "--label", "Groom");
    run("task", "archive", "FILTER-3");

    const listed = JSON.parse(
      run("task", "list", "FILTER", "--label", "cli", "--label", "GROOM", "--json").stdout,
    );
    expect(listed.map((entry: { key: string }) => entry.key)).toEqual(["FILTER-1"]);

    const searched = run(
      "task",
      "search",
      "labels",
      "FILTER",
      "--label",
      "CLI",
      "--label",
      "Groom",
    );
    expect(searched.code).toBe(0);
    expect(searched.stdout).toContain("FILTER-1");
    expect(searched.stdout).not.toContain("FILTER-2");

    const archived = run("task", "list", "FILTER", "--archived", "--label", "groom");
    expect(archived.stdout).toContain("FILTER-3");
    expect(run("task", "list", "--label", "missing").stderr).toContain(
      'A label with name "missing" does not exist',
    );
    expect(run("task", "search", "labels", "--label", "missing").code).toBe(1);
  });
});

test("project-scoped task list aligns one- and two-digit task numbers", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "TEN", "--name", "Ten tasks"], testDir);
    for (let number = 1; number <= 10; number++) {
      runZinn(["task", "create", "TEN", "--title", `task ${number}`], testDir);
    }

    const result = runZinn(["task", "list", "TEN"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(lines).toHaveLength(10);
    expect(lines).toContain(`TEN-1  | Backlog | - | task 1`);
    expect(lines).toContain(`TEN-10 | Backlog | - | task 10`);
  });
});

test("task list prints labels after the title, and a task without labels ends at its title", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    run("project", "create", "TAGS");
    run("label", "create", "bug");
    run("label", "create", "cli");
    run("label", "create", "docs");
    run("task", "create", "TAGS", "--title", "No labels");
    run("task", "create", "TAGS", "--title", "One label", "--label", "bug");
    run("task", "create", "TAGS", "--title", "Several labels", "--label", "bug", "--label", "cli", "--label", "docs");

    const result = run("task", "list", "TAGS");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "TAGS-1 | Backlog | - | No labels",
        "TAGS-2 | Backlog | - | One label | bug",
        "TAGS-3 | Backlog | - | Several labels | bug, cli, docs",
        "",
      ].join("\n"),
    );
  });
});

test("task view resolves a case-insensitive key and prints its canonical form", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "VIEW", "--name", "Viewed"], testDir);
    runZinn(["task", "create", "VIEW", "--title", "visible task", "--description", "visible description"], testDir);

    const result = runZinn(["task", "view", "vIeW-1"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `VIEW-1 | Backlog | - | visible task\n\n${SECTION_RULE}\nDescription:\nvisible description\n`,
    );
  });
});

test("task view prints the task row followed by Description, Relations, and Comments sections", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir, { TZ: "Europe/Berlin" });
    const description = "First line of the description.\nSecond line.";
    run("project", "create", "MDR");
    run("label", "create", "bug");
    run("label", "create", "cli");
    run("task", "create", "MDR", "--title", "Refine the numbers", "--description", description, "--priority", "high", "--label", "cli", "--label", "bug");
    run("task", "create", "MDR", "--title", "Check the totals");
    run("task", "relation", "create", "MDR-1", "MDR-2", "--type", "dependency");
    run("task", "comment", "create", "MDR-1", "--text", "Ready for review");
    run("task", "move", "MDR-1", "In Progress");
    const commentedAt = Date.UTC(2026, 8, 25, 17, 42);
    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ?, updated_at = ?", [commentedAt, commentedAt]);
    });

    const viewed = run("task", "view", "MDR-1");

    expect(viewed.code).toBe(0);
    expect(viewed.stderr).toBe("");
    expect(viewed.stdout).toBe(
      [
        "MDR-1 | In Progress | High | Refine the numbers | bug, cli",
        "",
        SECTION_RULE,
        "Description:",
        "First line of the description.",
        "Second line.",
        "",
        SECTION_RULE,
        "Relations:",
        "Depends on | MDR-2 | Backlog | Check the totals",
        "",
        SECTION_RULE,
        "Comments:",
        "MDR-1#1 | 2026-09-25 19:42 +02:00 | Ready for review",
        "",
      ].join("\n"),
    );

    expect(JSON.parse(run("task", "view", "MDR-1", "--json").stdout)).toEqual({
      key: "MDR-1",
      status: "Active",
      column: "In Progress",
      title: "Refine the numbers",
      description,
      priority: "high",
      labels: ["bug", "cli"],
      relations: [
        {
          type: "dependency",
          direction: "outgoing",
          task: { key: "MDR-2", column: "Backlog", title: "Check the totals", status: "Active" },
        },
      ],
      comments: [
        { key: "MDR-1#1", text: "Ready for review", created_at: commentedAt, updated_at: commentedAt },
      ],
    });
  });
});

test("task view leaves out the Description section for a task without a description", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "NONE", "--name", "No description"], testDir);
    runZinn(["task", "create", "NONE", "--title", "title only"], testDir);
    runZinn(["task", "create", "NONE", "--title", "other task"], testDir);

    const result = runZinn(["task", "view", "NONE-1"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`NONE-1 | Backlog | - | title only\n`);

    runZinn(["task", "relation", "create", "NONE-1", "NONE-2", "--type", "related"], testDir);
    expect(runZinn(["task", "view", "NONE-1"], testDir).stdout).toBe(
      `NONE-1 | Backlog | - | title only\n\n${SECTION_RULE}\nRelations:\nRelated to | NONE-2 | Backlog | other task\n`,
    );
  });
});

test("task view sizes section rules to the terminal even when color is disabled", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    runZinn(["project", "create", "W"], dir);
    const description = "中文 🧑‍🌾\n  Keep this indentation";
    runZinn(["task", "create", "W", "--title", "Width", "--description", description], dir);
    runZinn(["task", "create", "W", "--title", "Other"], dir);
    runZinn(["task", "relation", "create", "W-1", "W-2", "--type", "related"], dir);
    runZinn(["task", "comment", "create", "W-1", "--text", "A comment"], dir);

    const colorEnvironments: Array<Record<string, string>> = [
      { FORCE_COLOR: "1" },
      { NO_COLOR: "1", FORCE_COLOR: "0" },
    ];
    for (const columns of [20, 80, 160]) {
      for (const env of colorEnvironments) {
        const result = await runZinnInTerminal(["task", "view", "W-1"], dir, env, columns);
        expect(result.code).toBe(0);
        const rule = "-".repeat(columns);
        const expectedRule = env.FORCE_COLOR === "1" ? dim(rule) : rule;
        const rules = result.output.split("\n").filter((line) => line === expectedRule);
        expect(rules).toHaveLength(3);
        expect(result.output).toContain(description);
      }
    }

    const piped = runZinn(["task", "view", "W-1"], dir, { COLUMNS: "160", FORCE_COLOR: "0" });
    expect(piped.stdout.split("\n").filter((line) => line === SECTION_RULE)).toHaveLength(3);
  });
});

test("task view of an archived task shows Archived after the key and full priority", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    run("project", "create", "MDR");
    run("label", "create", "bug");
    run("task", "create", "MDR", "--title", "Refine the numbers", "--description", "Shelved", "--priority", "high", "--label", "bug");
    run("task", "archive", "MDR-1");

    const archivedRow = "MDR-1 | Archived | Backlog | H | Refine the numbers | bug";
    expect(run("task", "list", "MDR", "--all").stdout).toBe(`${archivedRow}\n`);
    expect(run("task", "view", "MDR-1").stdout).toBe(`MDR-1 | Archived | Backlog | High | Refine the numbers | bug\n\n${SECTION_RULE}\nDescription:\nShelved\n`);

    run("task", "unarchive", "MDR-1");
    expect(run("task", "view", "MDR-1").stdout).toBe(
      `MDR-1 | Backlog | High | Refine the numbers | bug\n\n${SECTION_RULE}\nDescription:\nShelved\n`,
    );
  });
});

test("human task output omits empty descriptions while JSON returns null", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EMPTY", "--name", "Empty description"], testDir);

    const created = runZinn(
      ["task", "create", "EMPTY", "--title", "Empty description", "--description", ""],
      testDir,
    );
    expect(created.stdout).toBe(`EMPTY-1 | Backlog | - | Empty description\n`);

    expect(runZinn(["task", "list", "EMPTY"], testDir).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );
    expect(runZinn(["task", "search", "Empty", "EMPTY"], testDir).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );
    expect(runZinn(["task", "view", "EMPTY-1"], testDir).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );

    runZinn(["task", "edit", "EMPTY-1", "--description", "Visible"], testDir);
    expect(runZinn(["task", "edit", "EMPTY-1", "--description", ""], testDir).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );

    expect(JSON.parse(runZinn(["task", "list", "EMPTY", "--json"], testDir).stdout)).toEqual([
      expect.objectContaining({ key: "EMPTY-1", description: null }),
    ]);
  });
});

test("task move, list and view color workflow column names only in a terminal, while JSON stays raw", async () => {
  await withIsolatedZinnDirAsync(async (testDir) => {
    runZinn(["project", "create", "COLOR", "--name", "Column colors"], testDir);
    runZinn(["task", "create", "COLOR", "--title", "waiting"], testDir);
    runZinn(["task", "create", "COLOR", "--title", "finished"], testDir);

    const moved = await runZinnInTerminal(["task", "move", "COLOR-2", "Done"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.output).toBe(`COLOR-2${DIM_SEPARATOR}${GREEN_DONE}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}finished\n`);

    expect((await runZinnInTerminal(["task", "list", "COLOR"], testDir)).output).toBe(
      [
        `COLOR-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}waiting`,
        `COLOR-2${DIM_SEPARATOR}\x1b[32m${"Done".padEnd("Backlog".length)}\x1b[39m${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}finished`,
        "",
      ].join("\n"),
    );
    expect((await runZinnInTerminal(["task", "view", "COLOR-1"], testDir)).output).toContain(
      GRAY_BACKLOG,
    );
    expect((await runZinnInTerminal(["task", "view", "COLOR-2"], testDir)).output).toContain(
      GREEN_DONE,
    );

    // Piped output keeps the same layout without color codes.
    expect(runZinn(["task", "list", "COLOR"], testDir).stdout).toBe(
      ["COLOR-1 | Backlog | - | waiting", "COLOR-2 | Done    | - | finished", ""].join("\n"),
    );
    expect(runZinn(["task", "view", "COLOR-2"], testDir).stdout).toBe("COLOR-2 | Done | - | finished\n");
    expect(runZinn(["task", "move", "COLOR-2", "Done"], testDir).stdout).toBe(
      "COLOR-2 | Done | - | finished\n",
    );

    const listedJson = runZinn(["task", "list", "COLOR", "--json"], testDir).stdout;
    expect(listedJson).not.toContain("\x1b");
    expect(JSON.parse(listedJson).map((task: { column: string }) => task.column)).toEqual([
      "Backlog",
      "Done",
    ]);
  });
});

test("task view requires a task key", () => {
  withIsolatedZinnDir((testDir) => {
    const result = runZinn(["task", "view"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: zinn task view");
  });
});

test("task view rejects malformed task keys with an actionable error", () => {
  withIsolatedZinnDir((testDir) => {
    for (const invalidKey of ["VIEW", "VIEW-", "VIEW-one", "VIEW-1-extra"]) {
      const result = runZinn(["task", "view", invalidKey], testDir);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Invalid task key "${invalidKey}"`);
      expect(result.stderr).toContain("Expected format PROJECT-1");
    }

    // ? ZINN-51: a word that begins with a dash is read as a word only after --.
    const dashKey = runZinn(["task", "view", "--", "-1"], testDir);
    expect(dashKey.code).toBe(1);
    expect(dashKey.stdout).toBe("");
    expect(dashKey.stderr).toContain(`Invalid task key "-1"`);
    expect(dashKey.stderr).toContain("Expected format PROJECT-1");
  });
});

test("task view distinguishes an unknown project from an unknown task number", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KNOWN", "--name", "Known"], testDir);

    const unknownProject = runZinn(["task", "view", "NOPE-1"], testDir);
    const unknownTask = runZinn(["task", "view", "KNOWN-99"], testDir);

    expect(unknownProject.code).toBe(1);
    expect(unknownProject.stderr).toContain(`Project with key "NOPE" does not exist!`);
    expect(unknownTask.code).toBe(1);
    expect(unknownTask.stderr).toContain(`Task "KNOWN-99" does not exist!`);
  });
});

test("task and comment key numbers are capped at 15 digits", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "CAP", "--name", "Cap"], testDir);
    runZinn(["task", "create", "CAP", "--title", "Only task"], testDir);

    const tooManyDigits = "9".repeat(20);
    const fifteenDigits = "9".repeat(15);

    // 16+ digits: rejected as a malformed key, never rounded and looked up.
    const invalidTask = runZinn(["task", "view", `CAP-${tooManyDigits}`], testDir);
    expect(invalidTask.stderr).toContain(`Invalid task key "CAP-${tooManyDigits}"`);

    const invalidComment = runZinn(
      ["task", "comment", "edit", `CAP-1#${tooManyDigits}`, "--text", "x"],
      testDir,
    );
    expect(invalidComment.stderr).toContain(`Invalid comment key "CAP-1#${tooManyDigits}"`);

    // Exactly 15 digits: still a well-formed key (an exact JS integer), just not found.
    const missingTask = runZinn(["task", "view", `CAP-${fifteenDigits}`], testDir);
    expect(missingTask.stderr).toContain(`Task "CAP-${fifteenDigits}" does not exist!`);

    const missingComment = runZinn(
      ["task", "comment", "edit", `CAP-1#${fifteenDigits}`, "--text", "x"],
      testDir,
    );
    expect(missingComment.stderr).toContain(`Comment "CAP-1#${fifteenDigits}" does not exist`);
  });
});

test("task comments can be created, listed, edited, viewed, and deleted", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "NOTE"], testDir);
    runZinn(["task", "create", "NOTE", "--title", "Commented task"], testDir);

    const first = runZinn(
      ["task", "comment", "create", "NOTE-1", "--text", "First comment"],
      testDir,
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("NOTE-1#1 | First comment\n");

    const second = JSON.parse(
      runZinn(
        ["task", "comment", "create", "note-1", "--text", "Second comment", "--json"],
        testDir,
      ).stdout,
    );
    expect(second).toEqual({
      key: "NOTE-1#2",
      text: "Second comment",
      created_at: second.created_at,
      updated_at: second.updated_at,
    });
    expect(second.created_at).toBeNumber();
    expect(second.updated_at).toBe(second.created_at);

    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 1", [
        Date.UTC(2026, 8, 24, 9, 5),
      ]);
      db.run("UPDATE comment SET created_at = ? WHERE number = 2", [
        Date.UTC(2026, 8, 25, 17, 42),
      ]);
    });

    expect(
      runZinn(["task", "comment", "list", "NOTE-1"], testDir, {
        TZ: "Europe/Berlin",
      }).stdout,
    ).toBe(
      "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment\n" +
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Second comment\n",
    );

    expect(
      runZinn(
        ["task", "comment", "edit", second.key, "--text", "Edited second"],
        testDir,
      ).stdout,
    ).toBe("NOTE-1#2 | Edited second\n");

    const viewed = runZinn(["task", "view", "NOTE-1"], testDir, {
      TZ: "Europe/Berlin",
    });
    expect(viewed.stdout).toContain(
      `\n\n${SECTION_RULE}\nComments:\n` +
        "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment\n" +
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Edited second\n",
    );

    const viewedJson = JSON.parse(
      runZinn(["task", "view", "NOTE-1", "--json"], testDir).stdout,
    );
    expect(viewedJson.comments.map((entry: { key: string }) => entry.key)).toEqual([
      "NOTE-1#1",
      "NOTE-1#2",
    ]);

    const deleted = runZinnWithConfirmation(
      ["task", "comment", "delete", "NOTE-1#2"],
      testDir,
    );
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain("Deleted NOTE-1#2");

    expect(
      runZinn(["task", "comment", "create", "NOTE-1", "--text", "Third comment"], testDir)
        .stdout,
    ).toBe("NOTE-1#3 | Third comment\n");

    expect(
      runZinn(["task", "comment", "create", "NOTE-1", "--text", "Line one\nLine two"], testDir)
        .stdout,
    ).toBe("NOTE-1#4 | Line one\n           Line two\n");

    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 4", [
        Date.UTC(2026, 8, 25, 18, 7),
      ]);
    });

    const multilinePrefix = "NOTE-1#4 | 2026-09-25 20:07 +02:00 | ";
    expect(
      runZinn(["task", "comment", "list", "NOTE-1"], testDir, {
        TZ: "Europe/Berlin",
      }).stdout,
    ).toContain(`${multilinePrefix}Line one\n${" ".repeat(multilinePrefix.length)}Line two\n`);
  });
});

test("comment lists pad the key so #1 lines up with #10 and keep continuation lines under the text", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "PAD"], testDir);
    runZinn(["task", "create", "PAD", "--title", "Many comments"], testDir);

    const createComment = (number: number) => {
      const isMultiline = number === 1 || number === 10;
      const text = isMultiline ? `Comment ${number}\nsecond line` : `Comment ${number}`;

      return runZinn(["task", "comment", "create", "PAD-1", "--text", text], testDir);
    };
    for (let number = 1; number <= 9; number += 1) {
      createComment(number);
    }
    const tenth = createComment(10);
    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ?", [Date.UTC(2026, 8, 25, 18, 7)]);
    });

    // One comment on its own has nothing to line up with and prints no timestamp.
    expect(tenth.stdout).toBe("PAD-1#10 | Comment 10\n           second line\n");

    const timestamp = "2026-09-25 20:07 +02:00";
    // Later lines start under the text of the first line, after the padded key.
    const textIndent = " ".repeat(`PAD-1#10 | ${timestamp} | `.length);
    const listed = runZinn(["task", "comment", "list", "PAD-1"], testDir, { TZ: "Europe/Berlin" }).stdout;
    expect(listed).toBe(
      [
        `PAD-1#1  | ${timestamp} | Comment 1`,
        `${textIndent}second line`,
        `PAD-1#2  | ${timestamp} | Comment 2`,
        `PAD-1#3  | ${timestamp} | Comment 3`,
        `PAD-1#4  | ${timestamp} | Comment 4`,
        `PAD-1#5  | ${timestamp} | Comment 5`,
        `PAD-1#6  | ${timestamp} | Comment 6`,
        `PAD-1#7  | ${timestamp} | Comment 7`,
        `PAD-1#8  | ${timestamp} | Comment 8`,
        `PAD-1#9  | ${timestamp} | Comment 9`,
        `PAD-1#10 | ${timestamp} | Comment 10`,
        `${textIndent}second line`,
        "",
      ].join("\n"),
    );

    const viewed = runZinn(["task", "view", "PAD-1"], testDir, { TZ: "Europe/Berlin" }).stdout;
    expect(viewed).toContain(`\n\n${SECTION_RULE}\nComments:\n${listed}`);
  });
});

test("task comment commands validate their inputs without partial writes", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "NOTE"], testDir);
    runZinn(["task", "create", "NOTE", "--title", "Commented task"], testDir);

    const cases: Array<[Array<string>, string]> = [
      [["task", "comment", "create", "NOTE-1"], "Comment text must be specified"],
      [["task", "comment", "create", "NOTE-1", "--text", "   "], "cannot be blank"],
      [
        ["task", "comment", "create", "NOTE-1", "--text", "one", "--text", "two"],
        "only be specified once",
      ],
      [["task", "comment", "list"], "Usage: zinn task comment list"],
      [["task", "comment", "edit", "NOTE-1#1"], "Comment text must be specified"],
      [
        ["task", "comment", "edit", "019dbfc3-f513-7000-8000-000000000000", "--text", "No"],
        "Invalid comment key",
      ],
      [["task", "comment", "delete"], "Usage: zinn task comment delete"],
    ];

    for (const [args, message] of cases) {
      const result = runZinn(args, testDir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
    }

    expect(runZinn(["task", "comment", "list", "NOTE-1"], testDir).stdout).toBe("");
  });
});

test("task move requires a task key and target column", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["task", "move"], testDir).stderr).toContain("Usage: zinn task move");
    expect(runZinn(["task", "move", "MOVE-1"], testDir).stderr).toContain("Usage: zinn task move");
  });
});

test("task move help documents destination placement", () => {
  const longHelp = runZinn(["task", "move", "--help"]);
  const shortHelp = runZinn(["task", "move", "-h"]);

  expect(longHelp.code).toBe(0);
  expect(longHelp.stderr).toBe("");
  expect(longHelp.stdout).toContain("Usage: zinn task move <task-key>... <target-column>");
  expect(longHelp.stdout).toContain(
    "Moving a task to a different column lists it last in that column,",
  );
  expect(longHelp.stdout).toContain(
    "Giving a task's current column as the target will not do anything, and a note says so.",
  );
  expect(longHelp.stdout).toContain(
    "Archived tasks must be unarchived before they can be moved.",
  );
  expect(shortHelp.code).toBe(0);
  expect(shortHelp.stdout).toBe(longHelp.stdout);
});

test("task move rejects a column outside the task's project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ORIGIN", "--name", "Origin"], testDir);
    runZinn(["project", "create", "OTHER", "--name", "Other"], testDir);
    runZinn(["project", "column", "create", "OTHER", "External"], testDir);
    runZinn(["task", "create", "ORIGIN", "--title", "stationary task"], testDir);

    const result = runZinn(["task", "move", "ORIGIN-1", "External"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Origin does not have a column named "External"`,
    );
    expect(runZinn(["task", "view", "ORIGIN-1"], testDir).stdout).toContain(
      `ORIGIN-1 | Backlog | - | stationary task`,
    );
  });
});

test("task move appends the task to the destination column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "MOVE", "--name", "Movable"], testDir);
    runZinn(["task", "create", "MOVE", "--title", "first task"], testDir);
    runZinn(["task", "create", "MOVE", "--title", "second task"], testDir);

    expect(runZinn(["task", "move", "MOVE-1", "In Progress"], testDir).code).toBe(0);
    expect(runZinn(["task", "move", "MOVE-2", "In Progress"], testDir).code).toBe(0);

    withTestDb(testDir, (db) => {
      const rows = db
        .query<
          {
            title: string;
            task_order: string;
            column_name: string;
            task_project: string;
            column_project: string;
          },
          []
        >(`SELECT task.title,
                  task.task_order,
                  project_column.name AS column_name,
                  task.project_id AS task_project,
                  project_column.project_id AS column_project
           FROM task
           JOIN project_column ON project_column.id = task.column_id
           ORDER BY task.task_order`)
        .all();

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.title)).toEqual(["first task", "second task"]);
      expect(rows.every((row) => row.column_name === "In Progress")).toBe(true);
      expect(rows.every((row) => row.task_project === row.column_project)).toBe(true);
      expect(rows[1]!.task_order > rows[0]!.task_order).toBe(true);
    });
  });
});

test("task move to the current column is a no-op", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "STILL", "--name", "Still"], testDir);
    runZinn(["task", "create", "STILL", "--title", "still task"], testDir);

    const before = withTestDb(testDir, (db) =>
      db.query<{ column_id: string; task_order: string; updated_at: number }, []>(
        "SELECT column_id, task_order, updated_at FROM task WHERE title = 'still task'",
      ).get(),
    );

    const result = runZinn(["task", "move", "STILL-1", "Backlog"], testDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`STILL-1 | Backlog | - | still task\n`);

    const after = withTestDb(testDir, (db) =>
      db.query<{ column_id: string; task_order: string; updated_at: number }, []>(
        "SELECT column_id, task_order, updated_at FROM task WHERE title = 'still task'",
      ).get(),
    );

    expect(after).toEqual(before);
  });
});

test("task move takes several tasks, appends them in argument order, and notes no-ops", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "MANY"], testDir);
    for (const title of ["one", "two", "three"]) {
      runZinn(["task", "create", "MANY", "--title", title], testDir);
    }
    runZinn(["task", "move", "MANY-1", "In Progress"], testDir);

    const result = runZinn(["task", "move", "MANY-3", "MANY-1", "MANY-2", "In Progress"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "MANY-3 | In Progress | - | three\nMANY-1 | In Progress | - | one\nMANY-2 | In Progress | - | two\n",
    );
    expect(result.stderr).toBe("MANY-1 was already in the In Progress column\n");
    expect(runZinn(["task", "list", "MANY"], testDir).stdout).toMatch(
      /^MANY-1[^\n]*\nMANY-3[^\n]*\nMANY-2[^\n]*\n$/,
    );
  });
});

test("task archive and unarchive take several tasks and note no-ops", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "SHELF"], testDir);
    for (const title of ["one", "two", "three"]) {
      runZinn(["task", "create", "SHELF", "--title", title], testDir);
    }
    runZinn(["task", "archive", "SHELF-2"], testDir);

    const archived = runZinn(["task", "archive", "SHELF-1", "SHELF-2"], testDir);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toBe(
      "SHELF-1 | Archived | Backlog | - | one\nSHELF-2 | Archived | Backlog | - | two\n",
    );
    expect(archived.stderr).toBe("SHELF-2 was already archived\n");

    const unarchived = runZinn(["task", "unarchive", "SHELF-2", "SHELF-3", "SHELF-1"], testDir);
    expect(unarchived.code).toBe(0);
    expect(unarchived.stderr).toBe("SHELF-3 was already active\n");
    expect(runZinn(["task", "list", "SHELF"], testDir).stdout).toMatch(
      /^SHELF-3[^\n]*\nSHELF-2[^\n]*\nSHELF-1[^\n]*\n$/,
    );
  });
});

test("task move, archive and unarchive align several tasks and note repeated keys", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "A"], testDir);
    runZinn(["project", "create", "LONG"], testDir);
    runZinn(["task", "create", "A", "--title", "short key"], testDir);
    runZinn(["task", "create", "LONG", "--title", "long key"], testDir);

    const moved = runZinn(["task", "move", "A-1", "LONG-1", "A-1", "Done"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toBe(
      "A-1    | Done | - | short key\nLONG-1 | Done | - | long key\nA-1    | Done | - | short key\n",
    );
    expect(moved.stderr).toBe("A-1 was already in the Done column\n");

    const archived = runZinn(["task", "archive", "A-1", "LONG-1", "A-1"], testDir);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toBe(
      "A-1    | Archived | Done | - | short key\nLONG-1 | Archived | Done | - | long key\nA-1    | Archived | Done | - | short key\n",
    );
    expect(archived.stderr).toBe("A-1 was already archived\n");

    const unarchived = runZinn(["task", "unarchive", "LONG-1", "A-1", "LONG-1"], testDir);
    expect(unarchived.code).toBe(0);
    expect(unarchived.stdout).toBe(
      "LONG-1 | Active | Done | - | long key\nA-1    | Active | Done | - | short key\nLONG-1 | Active | Done | - | long key\n",
    );
    expect(unarchived.stderr).toBe("LONG-1 was already active\n");
  });
});

test("task move, archive and unarchive change nothing when any task fails", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ATOM"], testDir);
    runZinn(["task", "create", "ATOM", "--title", "active"], testDir);
    runZinn(["task", "create", "ATOM", "--title", "archived"], testDir);
    runZinn(["task", "archive", "ATOM-2"], testDir);
    const before = runZinn(["task", "list", "ATOM", "--all", "--json"], testDir).stdout;

    const move = runZinn(["task", "move", "ATOM-1", "ATOM-2", "Done"], testDir);
    expect(move.code).toBe(1);
    expect(move.stderr).toContain('Archived task "ATOM-2" cannot be moved');

    const archive = runZinn(["task", "archive", "ATOM-1", "ATOM-404"], testDir);
    expect(archive.code).toBe(1);
    expect(archive.stderr).toContain('Task "ATOM-404" does not exist');

    const unarchive = runZinn(["task", "unarchive", "ATOM-2", "nope"], testDir);
    expect(unarchive.code).toBe(1);
    expect(unarchive.stderr).toContain('Invalid task key "nope"');

    expect(runZinn(["task", "list", "ATOM", "--all", "--json"], testDir).stdout).toBe(before);
  });
});

test("task move, archive and unarchive print an object for one task and an array for several with --json", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "SHAPE"], testDir);
    runZinn(["task", "create", "SHAPE", "--title", "one"], testDir);
    runZinn(["task", "create", "SHAPE", "--title", "two"], testDir);

    const moveOne = JSON.parse(runZinn(["task", "move", "SHAPE-1", "Done", "--json"], testDir).stdout);
    expect(moveOne).toMatchObject({ key: "SHAPE-1", column: "Done", changed: true });

    const moveUnchanged = JSON.parse(
      runZinn(["task", "move", "SHAPE-1", "Done", "--json"], testDir).stdout,
    );
    expect(moveUnchanged).toMatchObject({ key: "SHAPE-1", column: "Done", changed: false });

    const archiveMany = JSON.parse(
      runZinn(["task", "archive", "SHAPE-1", "SHAPE-2", "SHAPE-1", "--json"], testDir).stdout,
    );
    expect(archiveMany).toMatchObject([
      { key: "SHAPE-1", status: "Archived", changed: true },
      { key: "SHAPE-2", status: "Archived", changed: true },
      { key: "SHAPE-1", status: "Archived", changed: false },
    ]);

    const unarchiveOne = JSON.parse(
      runZinn(["task", "unarchive", "SHAPE-2", "--json"], testDir).stdout,
    );
    expect(unarchiveOne).toMatchObject({ key: "SHAPE-2", status: "Active", changed: true });
  });
});

test("task move prints the task row, while --json returns the full task", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["label", "create", "urgent"], testDir);
    runZinn(["project", "create", "BRIEF"], testDir);
    runZinn(
      ["task", "create", "BRIEF", "--title", "Detailed task", "--description", "Hidden from move output", "--priority", "high", "--label", "urgent"],
      testDir,
    );

    const moved = runZinn(["task", "move", "BRIEF-1", "In Progress"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toBe("BRIEF-1 | In Progress | H | Detailed task | urgent\n");
    expect(runZinn(["task", "list", "BRIEF"], testDir).stdout).toBe(moved.stdout);

    const movedJson = runZinn(["task", "move", "BRIEF-1", "Review", "--json"], testDir);
    expect(movedJson.code).toBe(0);
    expect(JSON.parse(movedJson.stdout)).toEqual({
      key: "BRIEF-1",
      status: "Active",
      column: "Review",
      title: "Detailed task",
      description: "Hidden from move output",
      priority: "high",
      labels: ["urgent"],
      changed: true,
    });
  });
});

test("task archive and unarchive print the same row with status for one task and for several", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["label", "create", "urgent"], testDir);
    runZinn(["project", "create", "ROW"], testDir);
    runZinn(["task", "create", "ROW", "--title", "one"], testDir);
    runZinn(
      ["task", "create", "ROW", "--title", "two", "--description", "Not in rows", "--priority", "high", "--label", "urgent"],
      testDir,
    );

    const archivedOne = runZinn(["task", "archive", "ROW-2"], testDir);
    expect(archivedOne.stdout).toBe("ROW-2 | Archived | Backlog | H | two | urgent\n");

    const unarchivedOne = runZinn(["task", "unarchive", "ROW-2"], testDir);
    expect(unarchivedOne.stdout).toBe("ROW-2 | Active | Backlog | H | two | urgent\n");

    const archivedSeveral = runZinn(["task", "archive", "ROW-1", "ROW-2"], testDir);
    expect(archivedSeveral.stdout).toBe(
      "ROW-1 | Archived | Backlog | - | one\nROW-2 | Archived | Backlog | H | two | urgent\n",
    );
    expect(archivedSeveral.stdout).toBe(runZinn(["task", "list", "ROW", "--all"], testDir).stdout);

    const unarchivedSeveral = runZinn(["task", "unarchive", "ROW-1", "ROW-2"], testDir);
    expect(unarchivedSeveral.stdout).toBe(
      "ROW-1 | Active | Backlog | - | one\nROW-2 | Active | Backlog | H | two | urgent\n",
    );
    expect(unarchivedSeveral.stdout).toBe(runZinn(["task", "list", "ROW", "--all"], testDir).stdout);
  });
});

test("task move prints the same row for one task and for several, as task list shows it", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ROW"], testDir);
    runZinn(["task", "create", "ROW", "--title", "one", "--priority", "low"], testDir);
    runZinn(["task", "create", "ROW", "--title", "two"], testDir);

    const movedOne = runZinn(["task", "move", "ROW-1", "Done"], testDir);
    expect(movedOne.stdout).toBe("ROW-1 | Done | L | one\n");

    const movedSeveral = runZinn(["task", "move", "ROW-2", "ROW-1", "In Progress"], testDir);
    expect(movedSeveral.stdout).toBe("ROW-2 | In Progress | - | two\nROW-1 | In Progress | L | one\n");
    expect(movedSeveral.stdout).toBe(runZinn(["task", "list", "ROW"], testDir).stdout);
  });
});

test("task delete prints the task row after Deleted, or after Deletion cancelled for when declined", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["label", "create", "urgent"], testDir);
    runZinn(["project", "create", "ROW"], testDir);
    runZinn(
      ["task", "create", "ROW", "--title", "one", "--description", "Not in rows", "--priority", "high", "--label", "urgent"],
      testDir,
    );
    const row = "ROW-1 | Backlog | H | one | urgent\n";

    // ? runZinn gives no stdin, so without --yes the prompt is declined.
    const cancelled = runZinn(["task", "delete", "ROW-1"], testDir);
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toEndWith(`Deletion cancelled for ${row}`);
    expect(runZinn(["task", "list", "ROW"], testDir).stdout).toBe(row);

    const deleted = runZinn(["task", "delete", "ROW-1", "--yes"], testDir);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toBe(`Deleted ${row}`);
    expect(runZinn(["task", "list", "ROW"], testDir).stdout).toBe("");
  });
});

test("task write commands print JSON with the full task details, unchanged by the row output", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["label", "create", "urgent"], testDir);
    runZinn(["project", "create", "ROW"], testDir);

    const created = runZinn(
      ["task", "create", "ROW", "--title", "one", "--description", "Full text", "--priority", "high", "--label", "urgent", "--json"],
      testDir,
    );
    expect(JSON.parse(created.stdout)).toEqual({
      key: "ROW-1",
      status: "Active",
      column: "Backlog",
      title: "one",
      description: "Full text",
      priority: "high",
      labels: ["urgent"],
    });

    const edited = runZinn(["task", "edit", "ROW-1", "--title", "uno", "--json"], testDir);
    expect(JSON.parse(edited.stdout)).toEqual({
      key: "ROW-1",
      status: "Active",
      column: "Backlog",
      title: "uno",
      description: "Full text",
      priority: "high",
      labels: ["urgent"],
    });

    const archived = runZinn(["task", "archive", "ROW-1", "--json"], testDir);
    expect(JSON.parse(archived.stdout)).toEqual({
      key: "ROW-1",
      status: "Archived",
      column: "Backlog",
      title: "uno",
      description: "Full text",
      priority: "high",
      labels: ["urgent"],
      changed: true,
    });
  });
});

test("task move rejects archived tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ARCHMOVE", "--name", "Archived move"], testDir);
    runZinn(["task", "create", "ARCHMOVE", "--title", "archived task"], testDir);
    runZinn(["task", "archive", "ARCHMOVE-1"], testDir);

    const before = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string; updated_at: number }, []>(
          "SELECT column_id, task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );

    const result = runZinn(
      ["task", "move", "ARCHMOVE-1", "In Progress"],
      testDir,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Archived task "ARCHMOVE-1" cannot be moved');

    const after = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string; updated_at: number }, []>(
          "SELECT column_id, task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );

    expect(after).toEqual(before);
  });
});

test("task order moves a task one position up or down within its column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ORDER", "--name", "Ordered"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "first task"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "second task"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "third task"], testDir);

    expect(runZinn(["task", "order", "ORDER-2", "up"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "ORDER"], testDir).stdout).toMatch(
      /ORDER-2[^\n]*\nORDER-1[^\n]*\nORDER-3/,
    );

    expect(runZinn(["task", "order", "ORDER-2", "down"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "ORDER"], testDir).stdout).toMatch(
      /ORDER-1[^\n]*\nORDER-2[^\n]*\nORDER-3/,
    );
  });
});

test("task order moves a task to the top or bottom of its column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EDGES", "--name", "Edges"], testDir);
    runZinn(["task", "create", "EDGES", "--title", "first task"], testDir);
    runZinn(["task", "create", "EDGES", "--title", "second task"], testDir);
    runZinn(["task", "create", "EDGES", "--title", "third task"], testDir);

    expect(runZinn(["task", "order", "EDGES-3", "top"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "EDGES"], testDir).stdout).toMatch(
      /EDGES-3[^\n]*\nEDGES-1[^\n]*\nEDGES-2/,
    );

    expect(runZinn(["task", "order", "EDGES-3", "bottom"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "EDGES"], testDir).stdout).toMatch(
      /EDGES-1[^\n]*\nEDGES-2[^\n]*\nEDGES-3/,
    );
  });
});

test("task order places a task immediately before or after its target", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ANCHOR", "--name", "Anchored"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "first task"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "second task"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "third task"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "fourth task"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "fifth task"], testDir);

    expect(runZinn(["task", "order", "ANCHOR-4", "before", "ANCHOR-2"], testDir).code).toBe(
      0,
    );
    expect(runZinn(["task", "list", "ANCHOR"], testDir).stdout).toMatch(
      /ANCHOR-1[^\n]*\nANCHOR-4[^\n]*\nANCHOR-2[^\n]*\nANCHOR-3[^\n]*\nANCHOR-5/,
    );

    expect(runZinn(["task", "order", "ANCHOR-4", "after", "ANCHOR-3"], testDir).code).toBe(
      0,
    );
    expect(runZinn(["task", "list", "ANCHOR"], testDir).stdout).toMatch(
      /ANCHOR-1[^\n]*\nANCHOR-2[^\n]*\nANCHOR-3[^\n]*\nANCHOR-4[^\n]*\nANCHOR-5/,
    );
  });
});

test("task order requires a task key and an ordering instruction", () => {
  const missingTask = runZinn(["task", "order"]);
  expect(missingTask.code).toBe(1);
  expect(missingTask.stderr).toContain("Usage: zinn task order");

  const missingInstruction = runZinn(["task", "order", "ORDER-1"]);
  expect(missingInstruction.code).toBe(1);
  expect(missingInstruction.stderr).toContain("Usage: zinn task order");
});

test("task order validates direction and target arguments", () => {
  const unknownDirection = runZinn(["task", "order", "ORDER-1", "sideways"]);
  expect(unknownDirection.code).toBe(1);
  expect(unknownDirection.stderr).toContain('Unknown order direction "sideways"');

  const missingTarget = runZinn(["task", "order", "ORDER-1", "before"]);
  expect(missingTarget.code).toBe(1);
  expect(missingTarget.stderr).toContain("Usage: zinn task order");

  const unexpectedTarget = runZinn(["task", "order", "ORDER-1", "top", "ORDER-2"]);
  expect(unexpectedTarget.code).toBe(1);
  expect(unexpectedTarget.stderr).toContain('"ORDER-2"');
  expect(unexpectedTarget.stderr).toContain("Usage: zinn task order");
});

test("task order help documents its own command", () => {
  const result = runZinn(["task", "order", "--help"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage: zinn task order");
  expect(result.stdout).toContain("top");
  expect(result.stdout).toContain("up");
  expect(result.stdout).toContain("down");
  expect(result.stdout).toContain("bottom");
  expect(result.stdout).toContain("before");
  expect(result.stdout).toContain("after");
});

test("task order does not cross a column boundary", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "BOUND", "--name", "Bounded"], testDir);
    runZinn(["task", "create", "BOUND", "--title", "backlog first"], testDir);
    runZinn(["task", "create", "BOUND", "--title", "backlog last"], testDir);
    runZinn(["task", "create", "BOUND", "--title", "progress first"], testDir);
    runZinn(["task", "move", "BOUND-3", "In Progress"], testDir);

    withTestDb(testDir, (db) => {
      db.run("UPDATE task SET updated_at = 1 WHERE number IN (2, 3)");
    });

    expect(runZinn(["task", "order", "BOUND-2", "down"], testDir).code).toBe(0);
    expect(runZinn(["task", "order", "BOUND-3", "up"], testDir).code).toBe(0);

    const rows = withTestDb(testDir, (db) =>
      db
        .query<{ number: number; updated_at: number }, []>(
          "SELECT number, updated_at FROM task WHERE number IN (2, 3) ORDER BY number",
        )
        .all(),
    );

    expect(rows).toEqual([
      { number: 2, updated_at: 1 },
      { number: 3, updated_at: 1 },
    ]);
  });
});

test("task order rejects an unknown target task", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "TARGET", "--name", "Targeted"], testDir);
    runZinn(["task", "create", "TARGET", "--title", "existing task"], testDir);

    const result = runZinn(["task", "order", "TARGET-1", "before", "TARGET-99"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Task "TARGET-99" does not exist!');
  });
});

test("task order rejects a target in another column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "SCOPE", "--name", "Scoped"], testDir);
    runZinn(["task", "create", "SCOPE", "--title", "backlog task"], testDir);
    runZinn(["task", "create", "SCOPE", "--title", "progress task"], testDir);
    runZinn(["task", "move", "SCOPE-2", "In Progress"], testDir);

    const result = runZinn(["task", "order", "SCOPE-1", "before", "SCOPE-2"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("same column");
  });
});

test("task order targeting itself is a no-op", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "UNCHANGED", "--name", "Unchanged"], testDir);
    runZinn(["task", "create", "UNCHANGED", "--title", "stationary task"], testDir);

    withTestDb(testDir, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));

    expect(
      runZinn(["task", "order", "UNCHANGED-1", "before", "UNCHANGED-1"], testDir).code,
    ).toBe(0);

    const row = withTestDb(testDir, (db) =>
      db
        .query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1")
        .get(),
    );

    expect(row?.updated_at).toBe(1);
  });
});

test("task order leaves already-satisfied placements unchanged", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "SATISFIED", "--name", "Satisfied"], testDir);
    runZinn(["task", "create", "SATISFIED", "--title", "first task"], testDir);
    runZinn(["task", "create", "SATISFIED", "--title", "second task"], testDir);
    runZinn(["task", "create", "SATISFIED", "--title", "third task"], testDir);

    withTestDb(testDir, (db) => db.run("UPDATE task SET updated_at = 1"));

    expect(runZinn(["task", "order", "SATISFIED-1", "top"], testDir).code).toBe(0);
    expect(runZinn(["task", "order", "SATISFIED-3", "bottom"], testDir).code).toBe(0);
    expect(
      runZinn(["task", "order", "SATISFIED-2", "before", "SATISFIED-3"], testDir).code,
    ).toBe(0);
    expect(
      runZinn(["task", "order", "SATISFIED-2", "after", "SATISFIED-1"], testDir).code,
    ).toBe(0);

    const timestamps = withTestDb(testDir, (db) =>
      db.query<{ updated_at: number }, []>("SELECT updated_at FROM task ORDER BY number").all(),
    );
    expect(timestamps).toEqual([{ updated_at: 1 }, { updated_at: 1 }, { updated_at: 1 }]);
  });
});

test("task order rejects a target in another project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "FIRST", "--name", "First"], testDir);
    runZinn(["project", "create", "SECOND", "--name", "Second"], testDir);
    runZinn(["task", "create", "FIRST", "--title", "first project task"], testDir);
    runZinn(["task", "create", "SECOND", "--title", "second project task"], testDir);

    const result = runZinn(
      ["task", "order", "FIRST-1", "before", "SECOND-1"],
      testDir,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("same project");
  });
});

test("task order rejects archived source and target tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ARCHORDER", "--name", "Archived order"], testDir);
    runZinn(["task", "create", "ARCHORDER", "--title", "active task"], testDir);
    runZinn(["task", "create", "ARCHORDER", "--title", "archived task"], testDir);
    runZinn(["task", "archive", "ARCHORDER-2"], testDir);

    const archivedSource = runZinn(["task", "order", "ARCHORDER-2", "top"], testDir);
    expect(archivedSource.code).toBe(1);
    expect(archivedSource.stderr).toContain("cannot be reordered");

    const archivedTarget = runZinn(
      ["task", "order", "ARCHORDER-1", "before", "ARCHORDER-2"],
      testDir,
    );
    expect(archivedTarget.code).toBe(1);
    expect(archivedTarget.stderr).toContain("cannot be an ordering target");
  });
});

test("task order uses visible active neighbours", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "VISIBLE", "--name", "Visible"], testDir);
    runZinn(["task", "create", "VISIBLE", "--title", "first task"], testDir);
    runZinn(["task", "create", "VISIBLE", "--title", "archived task"], testDir);
    runZinn(["task", "create", "VISIBLE", "--title", "third task"], testDir);
    runZinn(["task", "archive", "VISIBLE-2"], testDir);

    expect(runZinn(["task", "order", "VISIBLE-1", "down"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "VISIBLE"], testDir).stdout).toMatch(
      /VISIBLE-3[^\n]*\nVISIBLE-1/,
    );
  });
});

test("task archive hides a task from active lists without deleting it", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ARCH", "--name", "Archive"], testDir);
    runZinn(["task", "create", "ARCH", "--title", "kept task", "--description", "kept description"], testDir);
    runZinn(["task", "move", "ARCH-1", "In Progress"], testDir);

    const before = withTestDb(testDir, (db) =>
      db
        .query<
          {
            id: string;
            column_id: string;
            number: number;
            title: string;
            description: string;
            task_order: string;
            created_at: number;
            updated_at: number;
          },
          []
        >("SELECT * FROM task WHERE number = 1")
        .get(),
    )!;

    expect(runZinn(["task", "archive", "aRcH-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "ARCH"], testDir).stdout).toBe("");
    expect(runZinn(["task", "list", "ARCH", "--archived"], testDir).stdout).toContain(
      "ARCH-1 | In Progress | - | kept task",
    );
    expect(runZinn(["task", "list", "--all", "ARCH"], testDir).stdout).toContain("kept task");
    expect(runZinn(["task", "view", "ARCH-1"], testDir).stdout).toContain("kept task");

    withTestDb(testDir, (db) => {
      const after = db
        .query<
          typeof before & { archived_at: number },
          { $id: string }
        >("SELECT * FROM task WHERE id = $id")
        .get({ $id: before.id })!;

      expect(after.archived_at).toBeGreaterThan(0);
      expect(after.updated_at).toBe(after.archived_at);
      expect({
        id: after.id,
        column_id: after.column_id,
        number: after.number,
        title: after.title,
        description: after.description,
        task_order: after.task_order,
        created_at: after.created_at,
      }).toEqual({
        id: before.id,
        column_id: before.column_id,
        number: before.number,
        title: before.title,
        description: before.description,
        task_order: before.task_order,
        created_at: before.created_at,
      });
    });
  });
});

test("task list --all identifies active and archived tasks in a status column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "MIXED", "--name", "Mixed archive"], testDir);
    runZinn(["task", "create", "MIXED", "--title", "archived task"], testDir);
    runZinn(["task", "create", "MIXED", "--title", "active task"], testDir);
    runZinn(["task", "archive", "MIXED-1"], testDir);

    expect(runZinn(["task", "list", "MIXED"], testDir).stdout).toBe(
      `MIXED-2 | Backlog | - | active task\n`,
    );
    expect(runZinn(["task", "list", "MIXED", "--archived"], testDir).stdout).toBe(
      `MIXED-1 | Backlog | - | archived task\n`,
    );
    expect(runZinn(["task", "list", "MIXED", "--all"], testDir).stdout).toBe(
      [
        `MIXED-2 | Active   | Backlog | - | active task`,
        `MIXED-1 | Archived | Backlog | - | archived task`,
        "",
      ].join("\n"),
    );
  });
});

test("task unarchive appends the task after active tasks in its previous column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "RESTOREORDER", "--name", "Restore order"], testDir);
    runZinn(["task", "create", "RESTOREORDER", "--title", "first task"], testDir);
    runZinn(["task", "create", "RESTOREORDER", "--title", "second task"], testDir);
    runZinn(["task", "create", "RESTOREORDER", "--title", "third task"], testDir);
    runZinn(["task", "archive", "RESTOREORDER-1"], testDir);

    const archived = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string }, []>(
          "SELECT column_id, task_order FROM task WHERE number = 1",
        )
        .get(),
    )!;

    expect(runZinn(["task", "unarchive", "RESTOREORDER-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "RESTOREORDER"], testDir).stdout).toMatch(
      /RESTOREORDER-2[^\n]*\nRESTOREORDER-3[^\n]*\nRESTOREORDER-1/,
    );

    const restored = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string }, []>(
          "SELECT column_id, task_order FROM task WHERE number = 1",
        )
        .get(),
    )!;

    expect(restored.column_id).toBe(archived.column_id);
    expect(restored.task_order).not.toBe(archived.task_order);
  });
});

test("task unarchive help documents restored placement", () => {
  const result = runZinn(["task", "unarchive", "--help"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    "Unarchive tasks at the bottom of their previous columns, in the order given.",
  );
});

test("task archive is idempotent and unarchive restores active listing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "RESTORE", "--name", "Restore"], testDir);
    runZinn(["task", "create", "RESTORE", "--title", "restorable task"], testDir);
    runZinn(["task", "archive", "RESTORE-1"], testDir);

    withTestDb(testDir, (db) =>
      db.run("UPDATE task SET archived_at = 123, updated_at = 123 WHERE number = 1"),
    );
    expect(runZinn(["task", "archive", "RESTORE-1"], testDir).code).toBe(0);

    const stillArchived = withTestDb(testDir, (db) =>
      db
        .query<{ archived_at: number; updated_at: number }, []>(
          "SELECT archived_at, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );
    expect(stillArchived).toEqual({ archived_at: 123, updated_at: 123 });

    expect(runZinn(["task", "unarchive", "RESTORE-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "RESTORE"], testDir).stdout).toContain("restorable task");
    expect(runZinn(["task", "list", "RESTORE", "--archived"], testDir).stdout).toBe("");

    const restored = withTestDb(testDir, (db) =>
      db
        .query<{ archived_at: null; updated_at: number }, []>(
          "SELECT archived_at, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );
    expect(restored?.archived_at).toBeNull();
    expect(restored?.updated_at).toBeGreaterThan(123);

    withTestDb(testDir, (db) =>
      db.run("UPDATE task SET updated_at = 1 WHERE number = 1"),
    );
    const beforeActiveUnarchive = withTestDb(testDir, (db) =>
      db
        .query<{ task_order: string; updated_at: number }, []>(
          "SELECT task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );

    expect(runZinn(["task", "unarchive", "RESTORE-1"], testDir).code).toBe(0);

    const afterActiveUnarchive = withTestDb(testDir, (db) =>
      db
        .query<{ task_order: string; updated_at: number }, []>(
          "SELECT task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );
    expect(afterActiveUnarchive).toEqual(beforeActiveUnarchive);
  });
});

test("task archive and unarchive require a valid existing task key", () => {
  expect(runZinn(["task", "archive"]).stderr).toContain("Usage: zinn task archive");
  expect(runZinn(["task", "unarchive"]).stderr).toContain("Usage: zinn task unarchive");
  expect(runZinn(["task", "archive", "INVALID"]).stderr).toContain(
    'Invalid task key "INVALID"',
  );
  expect(runZinn(["task", "unarchive", "NOPE-1"]).stderr).toContain(
    'Project with key "NOPE" does not exist!',
  );
});

test("project list shows every established project", () => {
  runZinn(["project", "create", "LIST", "--name", "Listed"]);

  const result = runZinn(["project", "list"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("LIST");
});

test("task delete removes the task but not its project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    runZinn(["task", "create", "KEEP", "--title", "doomed task"], testDir);

    expect(runZinnWithConfirmation(["task", "delete", "KEEP-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "KEEP"], testDir).stdout).not.toContain("doomed task");
    expect(runZinn(["project", "list"], testDir).stdout).toContain("KEEP");
  });
});

test("task delete keeps the task when confirmation is declined", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    runZinn(["task", "create", "KEEP", "--title", "surviving task"], testDir);

    expect(runZinn(["task", "delete", "KEEP-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "KEEP"], testDir).stdout).toContain("surviving task");
  });
});

test("task delete requires a valid existing task key", () => {
  expect(runZinn(["task", "delete"]).stderr).toContain("Usage: zinn task delete");
  expect(runZinn(["task", "delete", "INVALID"]).stderr).toContain(
    'Invalid task key "INVALID"',
  );
});

test("task edit preserves omitted fields and identity, and accepts empty descriptions", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    runZinn(["task", "create", "EDIT", "--title", "Original", "--description", "Description"], dir);
    const read = () => withTestDb(dir, (db) =>
      db.query<import("../core/src/types").Task, []>("SELECT * FROM task").get()!);
    withTestDb(dir, (db) => db.run("UPDATE task SET updated_at = 1"));
    const before = read();
    expect(runZinn(["task", "edit", "edit-1", "--title", "New title"], dir).code).toBe(0);
    const after = read();
    expect(after).toEqual({ ...before, title: "New title", updated_at: after.updated_at });
    expect(after.updated_at).toBeGreaterThan(1);
    expect(runZinn(["task", "edit", "EDIT-1", "--description", ""], dir).code).toBe(0);
    expect(read().description).toBeNull();
    expect(read().title).toBe("New title");
    withTestDb(dir, (db) => db.run("UPDATE task SET updated_at = 1"));
    expect(runZinn(["task", "edit", "EDIT-1", "--title", "New title", "--description", ""], dir).code).toBe(0);
    expect(read().updated_at).toBe(1);
    expect(runZinn(["task", "edit", "--description=Changed", "EDIT-1", "--title=--example"], dir).code).toBe(0);
    expect(read()).toMatchObject({ title: "--example", description: "Changed" });
  });
});

test("task edit rejects invalid requests without partial writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    runZinn(["task", "create", "EDIT", "--title", "Original", "--description", "Description"], dir);
    const usage = "Usage: zinn task edit";
    // ? Each case lists the facts its error carries.
    const cases: Array<[string[], ...string[]]> = [
      [[], usage],
      [["EDIT-1"], "Provide at least one edit flag"],
      [["EDIT-1", "--title"], "argument missing"],
      [["EDIT-1", "--description"], "argument missing"],
      [["EDIT-1", "--unknown", "text"], "Unknown option"],
      [["EDIT-1", "extra", "--title", "text"], `"extra"`, usage],
      [["EDIT-1", "--title", "one", "--title", "two"], "only be specified once"],
      [["EDIT-1", "--title", ""], "Task title cannot be blank"],
      [["EDIT-1", "--title", "   "], "Task title cannot be blank"],
      [["EDIT-1", "--title", "", "--description", "Changed"], "Task title cannot be blank"],
      [["INVALID", "--title", "text"], "Invalid task key"],
      [["EDIT-99", "--title", "text"], "does not exist"],
    ];
    for (const [args, ...facts] of cases) {
      const result = runZinn(["task", "edit", ...args], dir);
      expect(result.code).toBe(1);
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
      expect(result.stdout).toBe("");
    }
    expect(runZinn(["task", "view", "EDIT-1"], dir).stdout).toBe(
      `EDIT-1 | Backlog | - | Original\n\n${SECTION_RULE}\nDescription:\nDescription\n`,
    );
  });
});

test("task edit preserves archive state and documents its flags", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    runZinn(["task", "create", "EDIT", "--title", "Original"], dir);
    runZinn(["task", "archive", "EDIT-1"], dir);
    expect(runZinn(["task", "edit", "EDIT-1", "--title", "Archived edit"], dir).code).toBe(0);
    expect(runZinn(["task", "list", "EDIT"], dir).stdout).toBe("");
    expect(runZinn(["task", "list", "EDIT", "--archived"], dir).stdout).toContain("Archived edit");
  });
  const help = runZinn(["task", "edit", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--description ""');
});

test("project and column mutations print the affected entity", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["project", "create", "life", "--name", "Responsive"], testDir).stdout).toBe(
      "LIFE | Responsive\n",
    );
    expect(
      runZinn(["project", "column", "create", "life", "Waiting"], testDir).stdout,
    ).toBe("LIFE | Waiting\n");
    expect(runZinnWithConfirmation(["project", "delete", "life"], testDir).stdout).toContain(
      "Deleted LIFE | Responsive\n",
    );
  });
});

test("task mutations print the resulting entity", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "LIFE", "--name", "Responsive"], testDir);

    expect(runZinn(["task", "create", "LIFE", "--title", "First", "--description", "Description"], testDir).stdout).toBe(
      `LIFE-1 | Backlog | - | First\n`,
    );
    runZinn(["task", "create", "LIFE", "--title", "Second"], testDir);
    expect(
      runZinn(["task", "edit", "life-1", "--title", "Updated"], testDir).stdout,
    ).toBe(`LIFE-1 | Backlog | - | Updated\n`);
    expect(runZinn(["task", "move", "LIFE-1", "TODO"], testDir).stdout).toBe(
      "LIFE-1 | TODO | - | Updated\n",
    );
    runZinn(["task", "move", "LIFE-2", "TODO"], testDir);
    expect(runZinn(["task", "order", "LIFE-2", "top"], testDir).stdout).toBe(
      "LIFE-2 | TODO | - | Second\n",
    );
    expect(runZinn(["task", "archive", "LIFE-1"], testDir).stdout).toBe(
      "LIFE-1 | Archived | TODO | - | Updated\n",
    );
    expect(runZinn(["task", "unarchive", "LIFE-1"], testDir).stdout).toBe(
      "LIFE-1 | Active | TODO | - | Updated\n",
    );
    expect(runZinnWithConfirmation(["task", "delete", "LIFE-1"], testDir).stdout).toContain(
      "Deleted LIFE-1 | TODO | - | Updated",
    );
    expect(runZinn(["task", "delete", "LIFE-2"], testDir).stdout).toContain(
      "Deletion cancelled for LIFE-2 | TODO | - | Second",
    );
  });
});

// ? Empty strings pass the routers' `== null` guards; core's validation rejects them.
test("empty-string arguments are rejected", () => {
  runZinn(["project", "create", "EMPTY", "--name", "Empty"]);

  const blankTitle = runZinn(["task", "create", "EMPTY", "--title", ""]);
  expect(blankTitle.code).toBe(1);
  expect(blankTitle.stderr).toContain("Task title cannot be blank");

  const blankProject = runZinn(["project", "create", "", "--name", ""]);
  expect(blankProject.code).toBe(1);
  expect(blankProject.stderr).toContain("Project key must start with a letter");
});

// --- TASK SEARCH

test("task search prints matches in task list rows and JSON shape", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    run("project", "create", "FIND");
    run("task", "create", "FIND", "--title", "Refine the numbers", "--description", "Quarterly quota", "--priority", "high");
    run("task", "create", "FIND", "--title", "Unrelated");
    run("task", "comment", "create", "FIND-2", "--text", "Blocked on refinement tools");

    const result = run("task", "search", "REFIN");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        `FIND-1 | Backlog | H | Refine the numbers`,
        `FIND-2 | Backlog | - | Unrelated`,
        "",
      ].join("\n"),
    );

    const listed = JSON.parse(run("task", "list", "FIND", "--json").stdout);
    const searched = JSON.parse(run("task", "search", "refine quota", "--json").stdout);
    expect(searched).toEqual([listed[0]]);
  });
});

test("task search finds a description-only match and prints its plain task row", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    const description = "Quarterly refinement checklist";
    run("project", "create", "SEEK");
    run("label", "create", "ops");
    run("task", "create", "SEEK", "--title", "Calibrate sensors", "--description", description, "--label", "ops");
    run("task", "create", "SEEK", "--title", "Unrelated");

    const result = run("task", "search", "checklist");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("SEEK-1 | Backlog | - | Calibrate sensors | ops\n");

    expect(JSON.parse(run("task", "search", "checklist", "--json").stdout)).toEqual([
      expect.objectContaining({ key: "SEEK-1", description, labels: ["ops"] }),
    ]);
  });
});

test("task search with no matches exits zero without output", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EMPTY"], dir);
    runZinn(["task", "create", "EMPTY", "--title", "Something"], dir);

    expect(runZinn(["task", "search", "nothing"], dir)).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(runZinn(["task", "search", "nothing", "--json"], dir)).toEqual({
      stdout: "[]\n",
      stderr: "",
      code: 0,
    });
  });
});

test("task search treats FTS syntax as text and accepts a leading dash after --", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "SYN"], dir);
    runZinn(["task", "create", "SYN", "--title", "Fix sign-in (again)", "--description", "AND NOT"], dir);

    for (const query of ["-", '"', ":", "(", "AND", "NOT", "*", 'sign-in "', "NEAR(a b)"]) {
      const result = runZinn(["task", "search", "--", query], dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }

    expect(runZinn(["task", "search", "--", "-sign"], dir).stdout).toContain("SYN-1");
    expect(runZinn(["task", "search", "(again) and not"], dir).stdout).toContain("SYN-1");
  });
});

test("task search treats --json and --help after -- as literal query text, not router flags", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "ESC"], dir);
    runZinn(["task", "create", "ESC", "--title", "Something"], dir);

    // Neither literal query matches any task; JSON mode would print "[]\n"
    // and a help request would print usage text, so empty output on both
    // stdout and stderr confirms "--json"/"--help" were searched for, not acted on.
    expect(runZinn(["task", "search", "--", "--json"], dir)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
    expect(runZinn(["task", "search", "--", "--help"], dir)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
  });
});

test("task search pins an exact task key before text matches", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "PIN"], dir);
    runZinn(["task", "create", "PIN", "--title", "Mentions pin-2 first"], dir);
    runZinn(["task", "create", "PIN", "--title", "The pinned task"], dir);

    const keys = JSON.parse(runZinn(["task", "search", "pin-2", "--json"], dir).stdout).map(
      (entry: { key: string }) => entry.key,
    );
    expect(keys).toEqual(["PIN-2", "PIN-1"]);
  });
});

test("task search hides archived matches with a stderr hint and filters by project and limit", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    run("project", "create", "ONE");
    run("project", "create", "TWO");
    run("task", "create", "ONE", "--title", "Widget active");
    run("task", "create", "ONE", "--title", "Widget archived");
    run("task", "create", "ONE", "--title", "Widget also archived");
    run("task", "create", "TWO", "--title", "Widget elsewhere");
    run("task", "archive", "ONE-2");
    run("task", "archive", "ONE-3");

    const active = run("task", "search", "widget", "one");
    expect(active.code).toBe(0);
    expect(active.stdout).toBe(`ONE-1 | Backlog | - | Widget active\n`);
    expect(active.stderr).toBe("2 archived matches hidden, use --all to include them\n");

    const activeJson = run("task", "search", "widget", "ONE", "--json");
    expect(JSON.parse(activeJson.stdout)).toHaveLength(1);
    expect(activeJson.stdout).not.toContain("hidden");
    expect(activeJson.stderr).toBe("2 archived matches hidden, use --all to include them\n");

    const single = run("task", "search", "ONE-2", "ONE");
    expect(single.stdout).toBe("");
    expect(single.stderr).toBe("1 archived match hidden, use --all to include them\n");

    const archived = run("task", "search", "widget", "ONE", "--archived");
    expect(archived.stderr).toBe("");
    expect(archived.stdout.trimEnd().split("\n").sort()).toEqual([
      `ONE-2 | Backlog | - | Widget archived`,
      `ONE-3 | Backlog | - | Widget also archived`,
    ]);

    const all = run("task", "search", "widget", "--all");
    expect(all.stderr).toBe("");
    expect(all.stdout.trimEnd().split("\n")).toHaveLength(4);
    expect(all.stdout).toContain(`ONE-2 | Archived | Backlog | - | Widget archived`);
    expect(all.stdout).toContain(`TWO-1 | Active   | Backlog | - | Widget elsewhere`);

    expect(run("task", "search", "widget", "--all", "--limit", "3").stdout.trimEnd().split("\n")).toHaveLength(3);
    expect(run("task", "search", "widget", "TWO").stdout).toBe(`TWO-1 | Backlog | - | Widget elsewhere\n`);
  });
});

test("task search validates its arguments", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "VAL"], dir);

    const usage = "Usage: zinn task search";
    // ? Each case lists the facts its error carries.
    const cases: Array<[Array<string>, ...string[]]> = [
      [[], usage],
      [[""], "Search query cannot be blank"],
      [["a", "VAL", "extra"], `"extra"`, usage],
      [["a", "--archived", "--all"], 'Use either "--archived" or "--all", not both'],
      [["a", "--limit", "0"], "Search limit must be a positive integer"],
      [["a", "--limit", "two"], "Search limit must be a positive integer"],
      [["a", "--limit", "0x5"], "Search limit must be a positive integer"],
      [["a", "--limit", "1e1"], "Search limit must be a positive integer"],
      [["a", "--limit", " 5 "], "Search limit must be a positive integer"],
      [["a", "--limit", "5."], "Search limit must be a positive integer"],
      [["a", "--limit", "1", "--limit", "2"], 'Option "--limit" can only be specified once'],
      [["a", "MISSING"], 'Project with key "MISSING" does not exist'],
    ];

    for (const [args, ...facts] of cases) {
      const result = runZinn(["task", "search", ...args], dir);
      expect(result.code).toBe(1);
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
    }
  });
});

// --- NOT YET TESTABLE

// ? Do not assert merely that stdout is JSON-parseable: `console.info` renders
// ? a flat string array as `[ "Backlog", ... ]`, which parses by coincidence.
// ? Assert the entity shape instead.
test("--json emits machine-readable output on read commands", () => {
  runZinn(["project", "create", "JSON", "--name", "Json"]);

  const result = runZinn(["project", "column", "list", "JSON", "--json"]);

  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed).toBeArray();
  expect(parsed[0]).toMatchObject({ name: "Backlog" });
});

test("--json prints the created entity on write commands, wherever the flag is placed", () => {
  withIsolatedZinnDir((testDir) => {
    const project = runZinn(["project", "create", "--json", "WEB", "--name", "Web"], testDir);
    expect(JSON.parse(project.stdout)).toEqual({ key: "WEB", name: "Web", description: null });

    const created = runZinn(["task", "create", "WEB", "--title", "Ship it", "--json"], testDir);

    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      key: "WEB-1",
      status: "Active",
      column: "Backlog",
      title: "Ship it",
      description: null,
      priority: null,
      labels: [],
    });
  });
});

test("--json combines a task and its relations into one document on task view", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "WEB"], testDir);
    runZinn(["task", "create", "WEB", "--title", "API"], testDir);
    runZinn(["task", "create", "WEB", "--title", "UI"], testDir);
    runZinn(["task", "relation", "create", "WEB-2", "WEB-1", "--type", "dependency"], testDir);

    const viewed = JSON.parse(runZinn(["task", "view", "WEB-2", "--json"], testDir).stdout);

    expect(viewed).toMatchObject({ key: "WEB-2", title: "UI" });
    expect(viewed.relations).toEqual([
      {
        type: "dependency",
        direction: "outgoing",
        task: { key: "WEB-1", column: "Backlog", title: "API", status: "Active" },
      },
    ]);
  });
});

test("--json prints an empty array for empty lists, while text output stays empty", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["project", "list"], testDir).stdout).toBe("");
    expect(JSON.parse(runZinn(["project", "list", "--json"], testDir).stdout)).toEqual([]);
    expect(JSON.parse(runZinn(["label", "list", "--json"], testDir).stdout)).toEqual([]);
  });
});

test("--json reports errors as JSON on stderr and leaves stdout empty", () => {
  const result = runZinn(["project", "create", "--json"]);

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  const parsed = JSON.parse(result.stderr);
  expect(Object.keys(parsed)).toEqual(["error"]);
  expect(Object.keys(parsed.error).sort()).toEqual(["help", "message"]);
  expect(parsed.error.message).toContain("<project-key>");
  expect(parsed.error.help).toContain("Usage: zinn project create");
});

test("--json refuses commands that ask for confirmation without --yes, deleting nothing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "WEB"], testDir);

    const result = runZinnWithConfirmation(["project", "delete", "WEB", "--json"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: { message: "Commands that ask for confirmation need --yes when used with --json" },
    });
    expect(runZinn(["project", "list"], testDir).stdout).toBe("WEB | WEB\n");
  });
});

test("--yes deletes without asking for confirmation", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "WEB"], testDir);
    runZinn(["task", "create", "WEB", "--title", "Ship it"], testDir);

    // ? runZinn gives no stdin, so without --yes the prompt would be declined.
    const result = runZinn(["task", "delete", "WEB-1", "--yes"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Deleted WEB-1 | Backlog | - | Ship it\n`);
    expect(runZinn(["task", "list", "WEB"], testDir).stdout).toBe("");
  });
});

test("delete commands with --yes and --json print the deleted entity", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const deleteJson = (...args: Array<string>) => {
      const result = run(...args, "--yes", "--json");
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout);
    };

    run("project", "create", "WEB", "--name", "Web");
    run("project", "create", "GONE", "--name", "Gone");
    run("task", "create", "WEB", "--title", "Ship it");
    run("task", "create", "WEB", "--title", "Keep it");
    run("task", "comment", "create", "WEB-2", "--text", "Looks good");
    run("label", "create", "urgent", "--color", "red", "--description", "Needs attention soon");

    expect(deleteJson("task", "delete", "WEB-1")).toEqual({
      key: "WEB-1",
      status: "Active",
      column: "Backlog",
      title: "Ship it",
      description: null,
      priority: null,
      labels: [],
    });
    expect(JSON.parse(run("task", "list", "WEB", "--json").stdout)).toMatchObject([
      { key: "WEB-2" },
    ]);

    const deletedComment = deleteJson("task", "comment", "delete", "WEB-2#1");
    expect(deletedComment).toEqual({
      key: "WEB-2#1",
      text: "Looks good",
      created_at: deletedComment.created_at,
      updated_at: deletedComment.updated_at,
    });
    expect(JSON.parse(run("task", "comment", "list", "WEB-2", "--json").stdout)).toEqual([]);

    expect(deleteJson("label", "delete", "urgent")).toEqual({
      name: "urgent",
      color: "red",
      description: "Needs attention soon",
    });
    expect(JSON.parse(run("label", "list", "--json").stdout)).toEqual([]);

    expect(deleteJson("project", "delete", "GONE")).toEqual({ key: "GONE", name: "Gone", description: null });
    expect(JSON.parse(run("project", "list", "--json").stdout)).toEqual([
      { key: "WEB", name: "Web", description: null },
    ]);
  });
});

// #TODO(build): distinct nonzero exit codes for not-found vs invalid-input vs
// #TODO DB error. Everything currently exits 1 via `quit`, so the tests above
// #TODO cannot distinguish "project missing" from "wrong number of args".
test.todo("failure classes have distinct exit codes", () => {
  expect(runZinn(["project", "delete", "NOSUCH"]).code).toBe(4); // ? not found
  expect(runZinn(["project", "create"]).code).toBe(2); // ? invalid input
});

// #TODO(refactor): `quit()` calls `process.exit`, so a handler cannot be called
// #TODO in-process without taking the runner down — every case here pays a
// #TODO subprocess spawn for it. ZINN-1 tracks the fix: handlers throw,
// #TODO `index.ts` catches and exits. Then the router/handler layer gets fast
// #TODO in-process unit tests and this file shrinks to a thin smoke suite.
test.todo("handlers throw instead of exiting, so they can be tested in-process", async () => {
  const { projectRouter } = await import("./src/routes/project-router");

  expect(() => projectRouter.create.run([])).toThrow(
    "Project key must be specified",
  );
});


test("project edit renames without changing identity, tasks, columns, or archive state", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Original"], dir);
    runZinn(["task", "create", "EDIT", "--title", "Keep task"], dir);
    const read = () => withTestDb(dir, (db) => ({
      project: db.query<import("../core/src/types").Project, []>("SELECT * FROM project").get()!,
      tasks: db.query("SELECT * FROM task").all(),
      columns: db.query("SELECT * FROM project_column").all(),
    }));
    withTestDb(dir, (db) => db.run("UPDATE project SET updated_at = 1, archived_at = 2"));
    const before = read();
    const result = runZinn(["project", "edit", "edit", "--name", "New name"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("EDIT | New name\n");
    expect(result.stderr).toBe("");
    const after = read();
    expect(after).toEqual({ ...before, project: {
      ...before.project, name: "New name", updated_at: after.project.updated_at,
    } });
    expect(after.project.updated_at).toBeGreaterThan(1);
    withTestDb(dir, (db) => db.run("UPDATE project SET updated_at = 1"));
    expect(runZinn(["project", "edit", "EDIT", "--name", "New name"], dir).code).toBe(0);
    expect(read().project.updated_at).toBe(1);
    expect(runZinn(["project", "edit", "--name=--example", "EDIT"], dir).code).toBe(0);
    expect(runZinn(["project", "list"], dir).stdout).toContain("EDIT | --example");
  });
});

test("project edit rejects invalid requests without writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Original"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project").get());
    const before = read();
    const usage = "Usage: zinn project edit";
    // ? Each case lists the facts its error carries.
    const cases: Array<[string[], ...string[]]> = [
      [[], usage],
      [["EDIT"], "Provide an edit flag"],
      [["EDIT", "--name"], "argument missing"],
      [["EDIT", "--key", "NEW"], "Unknown option"],
      [["EDIT", "extra", "--name", "Name"], `"extra"`, usage],
      [["EDIT", "--name", "One", "--name", "Two"], "only be specified once"],
      [["EDIT", "--name", ""], "blank or contain line breaks or control characters"],
      [["EDIT", "--name", "   "], "blank or contain line breaks or control characters"],
      [["EDIT", "--name", "Two\nlines"], "blank or contain line breaks or control characters"],
      [["MISSING", "--name", "Name"], "does not exist"],
    ];
    for (const [args, ...facts] of cases) {
      const result = runZinn(["project", "edit", ...args], dir);
      expect(result.code).toBe(1);
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
      expect(result.stdout).toBe("");
      expect(read()).toEqual(before);
    }
  });
});

// --- RELATIONS

test("relation commands show directional and symmetric links, including archived cross-project tasks", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect(run("project", "create", "APP").code).toBe(0);
    expect(run("project", "create", "OTHER").code).toBe(0);
    run("task", "create", "APP", "--title", "Copy");
    run("task", "create", "OTHER", "--title", "Original");
    expect(run("task", "relation", "list", "APP-1").stdout).toBe("");
    expect(run("task", "relation", "create", "APP-1", "APP-1", "--type", "related").stderr).toContain("itself");
    expect(run("task", "relation", "create", "APP-1", "OTHER-99", "--type", "related").code).toBe(1);
    expect(run("task", "relation", "list", "OTHER-99").code).toBe(1);
    for (const type of ["dependency", "duplicate", "related", "subtask"]) {
      const created = run("task", "relation", "create", "app-1", "OTHER-1", "--type", type);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain("APP-1");
      expect(created.stdout).toContain("OTHER-1");
    }
    const outgoing = run("task", "relation", "list", "APP-1");
    expect(outgoing.stdout).toContain("Depends on   | OTHER-1 | Backlog | Original");
    expect(outgoing.stdout).toContain("Duplicate of | OTHER-1 | Backlog | Original");
    expect(outgoing.stdout).toContain("Parent       | OTHER-1 | Backlog | Original");
    const incoming = run("task", "relation", "list", "OTHER-1");
    expect(incoming.stdout).toContain("Subtask        | APP-1 | Backlog | Copy");
    expect(incoming.stdout).toContain("Depended on by | APP-1 | Backlog | Copy");
    expect(incoming.stdout).toContain("Duplicated by  | APP-1 | Backlog | Copy");
    expect(incoming.stdout).toContain("Related to     | APP-1 | Backlog | Copy");
    expect(run("task", "relation", "create", "OTHER-1", "APP-1", "--type", "related").stderr).toContain("already exists");
    run("task", "archive", "OTHER-1");
    expect(run("task", "view", "APP-1").stdout).toContain("Parent       | OTHER-1 | Backlog | Original | Archived");
    const viewed = JSON.parse(run("task", "view", "APP-1", "--json").stdout);
    expect(viewed.relations).toContainEqual({
      type: "subtask", direction: "outgoing",
      task: { key: "OTHER-1", column: "Backlog", title: "Original", status: "Archived" },
    });
    expect(run("task", "relation", "create", "OTHER-1", "APP-1", "--type", "subtask").stderr).toContain("cycle");
    expect(run("task", "relation", "delete", "APP-1", "OTHER-1", "--type", "subtask").code).toBe(0);
    expect(run("task", "view", "APP-1").stdout).not.toContain("Parent");
    expect(run("task", "relation", "create", "OTHER-1", "APP-1", "--type", "dependency").code).toBe(0);
  });
});

test("relation list aligns and colors connected columns, and marks archived tasks", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    run("project", "create", "APP");
    run("project", "create", "LONGER");
    run("task", "create", "APP", "--title", "Copy");
    run("task", "create", "APP", "--title", "Plan");
    run("task", "create", "APP", "--title", "Review");
    run("task", "create", "LONGER", "--title", "Original");
    run("task", "move", "LONGER-1", "Done");
    expect(run("project", "column", "create", "APP", "Verification").code).toBe(0);
    expect(run("task", "move", "APP-3", "Verification").code).toBe(0);
    run("task", "archive", "APP-2");
    run("task", "relation", "create", "APP-1", "LONGER-1", "--type", "dependency");
    run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    run("task", "relation", "create", "APP-3", "APP-1", "--type", "dependency");

    // Relations come back in no promised order, so compare the lines sorted.
    const expectedLines = [
      "Depends on     | LONGER-1 | Done         | Original",
      "Related to     | APP-2    | Backlog      | Plan | Archived",
      "Depended on by | APP-3    | Verification | Review",
    ];
    const listed = run("task", "relation", "list", "APP-1").stdout;
    expect(listed.trimEnd().split("\n").sort()).toEqual([...expectedLines].sort());
    const colored = runZinn(["task", "relation", "list", "APP-1"], dir, { FORCE_COLOR: "1" }).stdout;
    expect(colored).toContain("\x1b[32mDone        \x1b[39m");
    expect(colored).toContain("\x1b[90mBacklog     \x1b[39m");
    expect(colored).toContain(`${DIM_SEPARATOR}Verification${DIM_SEPARATOR}`);
    expect(runZinn(["task", "relation", "list", "APP-1"], dir, { NO_COLOR: "1" }).stdout).toBe(listed);
    const json = JSON.parse(run("task", "relation", "list", "APP-1", "--json").stdout);
    expect(json.find((entry: { task: { key: string } }) => entry.task.key === "LONGER-1").task.column).toBe("Done");

    const viewed = run("task", "view", "APP-1").stdout;
    expect(viewed).toContain(`\n\n${SECTION_RULE}\nRelations:\n`);
    for (const line of expectedLines) {
      expect(viewed).toContain(`${line}\n`);
    }
  });
});

test("relation help and argument errors make types discoverable without prompting", () => {
  for (const args of [
    ["APP-1", "APP-2"],
    ["APP-1", "APP-2", "--type", "unknown"],
  ]) {
    const result = runZinn(["task", "relation", "create", ...args]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("related, dependency, duplicate, subtask");
  }
  for (const args of [
    ["APP-1", "--type", "related"],
    ["APP-1", "APP-2", "APP-3", "--type", "related"],
    ["APP-1", "APP-2", "--type", "related", "--type", "duplicate"],
    ["APP-1", "APP-2", "--typo", "related"],
  ]) {
    expect(runZinn(["task", "relation", "create", ...args]).code).toBe(1);
  }
  const help = runZinn(["task", "relation", "create", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Source is a duplicate of target");
  expect(runZinn(["task", "relation", "--help"]).stdout).toContain("  {create|list|delete}");
  expect(runZinn(["task", "relation", "list"]).code).toBe(1);
  expect(runZinn(["task", "relation", "list", "APP-1", "APP-2"]).code).toBe(1);
});

test("relation deletion is usable without a prompt and updates list and view", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    run("project", "create", "APP");
    run("task", "create", "APP", "--title", "First");
    run("task", "create", "APP", "--title", "Second");
    run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    run("task", "relation", "create", "APP-1", "APP-2", "--type", "dependency");
    const removed = run("task", "relation", "delete", "app-2", "APP-1", "--type", "related");
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Deleted related relation from APP-2 to APP-1");
    expect(run("task", "relation", "list", "APP-1").stdout).toContain("Depends on");
    expect(run("task", "view", "APP-2").stdout).not.toContain("Related to");
    expect(run("task", "relation", "delete", "APP-1", "APP-2", "--type", "related").stderr).toContain("does not exist");
    for (const args of [[], ["APP-1"], ["APP-1", "APP-2"],
      ["APP-1", "APP-2", "--type", "invalid"],
      ["APP-1", "APP-2", "--type", "related", "--type", "dependency"],
    ]) {
      expect(run("task", "relation", "delete", ...args).code).toBe(1);
    }
    expect(run("task", "relation", "delete", "--help").stdout).toContain("Remove only the specified relation");
    expect(run("task", "relation", "--help").stdout).toContain("  {create|list|delete}");
  });
});

test("global label workflows support repeated create/edit flags and preserve task content", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect(run("project", "create", "APP").code).toBe(0);
    for (const name of ["bug", "auth", "needs review, soon"]) {
      expect(run("label", "create", name, "--color", "red", "--description", "Details").code).toBe(0);
    }
    expect(run("label", "create", "BUG").stderr).toContain("already exists");
    expect(run("label", "create", "invalid", "--color", "purple").code).toBe(1);
    expect(run("label", "list").stdout).toContain(`${"bug".padEnd("needs review, soon".length)} | red | Details`);
    const created = run("task", "create", "APP", "--title", "Login", "--description", "", "--label", "BUG", "--label", "AUTH");
    expect(created.code).toBe(0);
    expect(created.stdout).toBe("APP-1 | Backlog | - | Login | auth, bug\n");
    const editedLabel = run("label", "edit", " BUG ", "--name", " defect ", "--color", "blue", "--description", "");
    expect(editedLabel.code).toBe(0);
    expect(editedLabel.stdout).toBe("defect | blue\n");
    expect(run("task", "view", "APP-1").stdout).toBe("APP-1 | Backlog | - | Login | auth, defect\n");
    expect(JSON.parse(run("label", "edit", "defect", "--description", "Fixed", "--json").stdout)).toEqual({
      name: "defect",
      color: "blue",
      description: "Fixed",
    });
    expect(run("task", "edit", "APP-1", "--title", "Changed", "--add-label", "NEEDS REVIEW, SOON", "--add-label", "AUTH", "--remove-label", "DEFECT").code).toBe(0);
    expect(run("task", "view", "APP-1").stdout).toBe(
      "APP-1 | Backlog | - | Changed | auth, needs review, soon\n",
    );
    expect(run("task", "edit", "APP-1", "--title", "Must not change", "--add-label", "unknown").code).toBe(1);
    expect(run("task", "view", "APP-1").stdout).toContain("Changed");
    expect(run("task", "edit", "APP-1", "--add-label", "BUG", "--remove-label", "bug").code).toBe(1);
    expect(run("task", "label", "add", "APP-1", "DEFECT").stdout).toBe(
      "APP-1 | Backlog | - | Changed | auth, defect, needs review, soon\n",
    );
    expect(run("task", "label", "remove", "APP-1", "AUTH", "dEfEcT").stdout).toBe(
      "APP-1 | Backlog | - | Changed | needs review, soon\n",
    );
    expect(runZinnWithConfirmation(["label", "delete", "NEEDS REVIEW, SOON"], dir).code).toBe(0);
    expect(run("task", "view", "APP-1").stdout).toBe("APP-1 | Backlog | - | Changed\n");
    expect(run("label", "list").stdout).toContain("auth");
    for (const args of [
      ["APP", "Old positional title"],
      ["APP", "--title", "One", "--title", "Two"],
      ["APP", "--title", "One", "--description", "A", "--description", "B"],
      ["APP", "--title", "One", "--unknown", "x"],
      ["APP", "--title", "One", "--label", "missing"],
    ]) {
      expect(run("task", "create", ...args).code).toBe(1);
    }
    expect(run("task", "create", "APP", "--title=--example").stdout).toContain("APP-2");
  });
});

test("label text output colors the name in a terminal and names the color when piped, while JSON keeps the color value", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);

    expect(run("label", "create", "bug", "--color", "red", "--description", "Broken").stdout).toBe(
      "bug | red | Broken\n",
    );
    expect(run("label", "create", "later").stdout).toBe("later | white\n");

    const createdInTerminal = await runZinnInTerminal(["label", "create", "chore", "--color", "gray"], dir);
    expect(createdInTerminal.code).toBe(0);
    expect(createdInTerminal.output).toBe("\x1b[90mchore\x1b[39m\n");

    const listed = run("label", "list").stdout;
    expect(listed).not.toContain("\x1b[");
    for (const line of ["bug   | red   | Broken", "chore | gray", "later | white"]) {
      expect(listed).toContain(`${line}\n`);
    }
    const listedInTerminal = (await runZinnInTerminal(["label", "list"], dir)).output;
    expect(listedInTerminal).toContain(`\x1b[31mbug  \x1b[39m${DIM_SEPARATOR}Broken\n`);
    for (const colorName of ["red", "white", "gray"]) {
      expect(listedInTerminal).not.toContain(colorName);
    }

    const created = run("label", "create", "docs", "--color", "cyan", "--json").stdout;
    expect(created).not.toContain("\x1b[");
    expect(JSON.parse(created)).toEqual({ name: "docs", color: "cyan", description: null });

    const listedJson = run("label", "list", "--json").stdout;
    expect(listedJson).not.toContain("\x1b[");
    expect(JSON.parse(listedJson)).toContainEqual({ name: "bug", color: "red", description: "Broken" });
  });
});

test("label list pads names and color words so descriptions line up, with no cell for a missing description", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    run("label", "create", "bug", "--color", "red", "--description", "Broken");
    run("label", "create", "chore", "--color", "magenta");
    run("label", "create", "documentation", "--color", "gray", "--description", "Docs");

    // The color word of the label without a description ends its row, and still sets the column's width.
    expect(run("label", "list").stdout).toBe(
      [
        "bug           | red     | Broken",
        "chore         | magenta",
        "documentation | gray    | Docs",
        "",
      ].join("\n"),
    );

    // A single label has nothing to line up with.
    expect(run("label", "edit", "documentation", "--description", "Guides").stdout).toBe(
      "documentation | gray | Guides\n",
    );
  });
});

test("label list pads a colored name by its plain text, so color codes do not shift the descriptions", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);
    runZinn(["label", "create", "chore", "--color", "gray"], dir);
    runZinn(["label", "create", "documentation", "--color", "blue", "--description", "Docs"], dir);

    // The name of a label without a description ends its row, so it is not padded.
    const expected =
      [
        `\x1b[31m${"bug".padEnd("documentation".length)}\x1b[39m${DIM_SEPARATOR}Broken`,
        "\x1b[90mchore\x1b[39m",
        `\x1b[34mdocumentation\x1b[39m${DIM_SEPARATOR}Docs`,
        "",
      ].join("\n");

    expect((await runZinnInTerminal(["label", "list"], dir)).output).toBe(expected);
    expect(runZinn(["label", "list"], dir, { FORCE_COLOR: "1" }).stdout).toBe(expected);
  });
});

test("NO_COLOR turns color off in a terminal, so text output reads as it does when piped", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    runZinn(["project", "create", "PLAIN"], dir);
    runZinn(["task", "create", "PLAIN", "--title", "waiting"], dir);
    runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);

    const noColor = { NO_COLOR: "1" };
    expect((await runZinnInTerminal(["task", "list", "PLAIN"], dir, noColor)).output).toBe(
      "PLAIN-1 | Backlog | - | waiting\n",
    );
    expect((await runZinnInTerminal(["label", "list"], dir, noColor)).output).toBe(
      "bug | red | Broken\n",
    );

    // An empty NO_COLOR counts as unset.
    expect((await runZinnInTerminal(["label", "list"], dir, { NO_COLOR: "" })).output).toBe(
      `\x1b[31mbug\x1b[39m${DIM_SEPARATOR}Broken\n`,
    );
  });
});

test("FORCE_COLOR colors piped output and wins over NO_COLOR, while FORCE_COLOR=0 turns color off", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    runZinn(["project", "create", "FORCE"], dir);
    runZinn(["task", "create", "FORCE", "--title", "waiting"], dir);
    runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);

    const coloredLabel = `\x1b[31mbug\x1b[39m${DIM_SEPARATOR}Broken\n`;
    expect(runZinn(["task", "list", "FORCE"], dir, { FORCE_COLOR: "1" }).stdout).toBe(
      `FORCE-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}waiting\n`,
    );
    expect(runZinn(["label", "list"], dir, { FORCE_COLOR: "1", NO_COLOR: "1" }).stdout).toBe(coloredLabel);

    // Any non-empty value other than 0 forces color; an empty FORCE_COLOR counts as unset.
    expect(runZinn(["label", "list"], dir, { FORCE_COLOR: "true" }).stdout).toBe(coloredLabel);
    expect(runZinn(["label", "list"], dir, { FORCE_COLOR: "" }).stdout).toBe("bug | red | Broken\n");
    expect((await runZinnInTerminal(["label", "list"], dir, { FORCE_COLOR: "0" })).output).toBe(
      "bug | red | Broken\n",
    );
  });
});

test("task rows color each attached label name by its label color, with dimmed separators and unchanged column widths", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    runZinn(["label", "create", "bug", "--color", "red"], dir);
    runZinn(["label", "create", "cli", "--color", "blue"], dir);
    runZinn(["label", "create", "docs", "--color", "cyan"], dir);
    runZinn(["project", "create", "TAGS", "--name", "Task labels"], dir);
    runZinn(
      ["task", "create", "TAGS", "--title", "Several labels", "--priority", "urgent", "--label", "docs", "--label", "bug", "--label", "cli"],
      dir,
    );
    runZinn(["task", "create", "TAGS", "--title", "No labels"], dir);
    runZinn(["task", "move", "TAGS-2", "Done"], dir);

    // Labels are listed by name, and only the names are colored: the ", " joins stay plain, and the " | " before them is dimmed like the others.
    const coloredLabels = "\x1b[31mbug\x1b[39m, \x1b[34mcli\x1b[39m, \x1b[36mdocs\x1b[39m";
    const coloredRows = [
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}U${DIM_SEPARATOR}Several labels${DIM_SEPARATOR}${coloredLabels}`,
      `TAGS-2${DIM_SEPARATOR}\x1b[32m${"Done".padEnd("Backlog".length)}\x1b[39m${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}No labels`,
      "",
    ].join("\n");

    expect((await runZinnInTerminal(["task", "list", "TAGS"], dir)).output).toBe(coloredRows);
    expect(runZinn(["task", "list", "TAGS"], dir, { FORCE_COLOR: "1" }).stdout).toBe(coloredRows);
    expect(runZinn(["task", "search", "Several", "TAGS"], dir, { FORCE_COLOR: "1" }).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}U${DIM_SEPARATOR}Several labels${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect(runZinn(["task", "list", "TAGS", "--all"], dir, { FORCE_COLOR: "1" }).stdout).toContain(
      `TAGS-1${DIM_SEPARATOR}Active${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}U${DIM_SEPARATOR}Several labels${DIM_SEPARATOR}${coloredLabels}\n`,
    );

    // A label's color applies to every task that has the label.
    runZinn(["label", "edit", "bug", "--color", "yellow"], dir);
    expect(runZinn(["task", "list", "TAGS"], dir, { FORCE_COLOR: "1" }).stdout).toContain(
      "\x1b[33mbug\x1b[39m, \x1b[34mcli\x1b[39m",
    );
  });
});

test("label names in task write rows and in task view are colored by their label color", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    runZinn(["label", "create", "bug", "--color", "red"], dir);
    runZinn(["label", "create", "docs", "--color", "cyan"], dir);
    runZinn(["project", "create", "TAGS"], dir);

    const forceColor = { FORCE_COLOR: "1" };
    const coloredLabels = "\x1b[31mbug\x1b[39m, \x1b[36mdocs\x1b[39m";

    expect(
      runZinn(["task", "create", "TAGS", "--title", "Tagged", "--label", "docs", "--label", "bug"], dir, forceColor).stdout,
    ).toBe(`TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`);
    expect(runZinn(["task", "view", "TAGS-1"], dir, forceColor).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect((await runZinnInTerminal(["task", "view", "TAGS-1"], dir)).output).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect(runZinn(["task", "label", "remove", "TAGS-1", "bug"], dir, forceColor).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}\x1b[36mdocs\x1b[39m\n`,
    );
    expect(runZinn(["task", "label", "add", "TAGS-1", "bug"], dir, forceColor).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect(
      runZinn(["task", "edit", "TAGS-1", "--title", "Retitled"], dir, forceColor).stdout,
    ).toBe(`TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Retitled${DIM_SEPARATOR}${coloredLabels}\n`);
  });
});

test("task rows dim the separators and the empty priority marker, whether or not the task has a priority or labels", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["label", "create", "bug", "--color", "red"], dir);
    runZinn(["project", "create", "DIM"], dir);
    runZinn(["task", "create", "DIM", "--title", "Both", "--priority", "high", "--label", "bug"], dir);
    runZinn(["task", "create", "DIM", "--title", "Priority only", "--priority", "low"], dir);
    runZinn(["task", "create", "DIM", "--title", "Labels only", "--label", "bug"], dir);
    runZinn(["task", "create", "DIM", "--title", "Neither"], dir);

    const forceColor = { FORCE_COLOR: "1" };
    const backlog = GRAY_BACKLOG;
    const red = "\x1b[31mbug\x1b[39m";
    // Priority letters stay plain; only the "-" that stands for no priority is dimmed.
    const dimmedRows = [
      `DIM-1${DIM_SEPARATOR}${backlog}${DIM_SEPARATOR}H${DIM_SEPARATOR}Both${DIM_SEPARATOR}${red}`,
      `DIM-2${DIM_SEPARATOR}${backlog}${DIM_SEPARATOR}L${DIM_SEPARATOR}Priority only`,
      `DIM-3${DIM_SEPARATOR}${backlog}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Labels only${DIM_SEPARATOR}${red}`,
      `DIM-4${DIM_SEPARATOR}${backlog}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Neither`,
      "",
    ].join("\n");
    const plainRows = [
      "DIM-1 | Backlog | H | Both | bug",
      "DIM-2 | Backlog | L | Priority only",
      "DIM-3 | Backlog | - | Labels only | bug",
      "DIM-4 | Backlog | - | Neither",
      "",
    ].join("\n");

    expect(runZinn(["task", "list", "DIM"], dir, forceColor).stdout).toBe(dimmedRows);
    expect(runZinn(["task", "list", "DIM"], dir).stdout).toBe(plainRows);
    expect(runZinn(["task", "list", "DIM"], dir, { NO_COLOR: "1" }).stdout).toBe(plainRows);
    expect(runZinn(["task", "view", "DIM-3"], dir, forceColor).stdout).toBe(
      dimmedRows.split("\n")[2] + "\n",
    );
    expect(runZinn(["task", "view", "DIM-3"], dir).stdout).toBe("DIM-3 | Backlog | - | Labels only | bug\n");
  });
});

test("task view bolds its section headings and dims the separators and comment timestamps, and reads plain when piped", () => {
  withIsolatedZinnDir((dir) => {
    const run = (env: Record<string, string>, ...args: Array<string>) =>
      runZinn(args, dir, { TZ: "Europe/Berlin", ...env });
    run({}, "project", "create", "MDR");
    run({}, "label", "create", "bug", "--color", "red");
    run({}, "label", "create", "cli", "--color", "blue");
    run({}, "task", "create", "MDR", "--title", "Refine the numbers", "--description", "First line.\nSecond line.", "--priority", "high", "--label", "cli", "--label", "bug");
    run({}, "task", "create", "MDR", "--title", "Check the totals");
    run({}, "task", "relation", "create", "MDR-1", "MDR-2", "--type", "dependency");
    run({}, "task", "comment", "create", "MDR-1", "--text", "Ready for review");
    run({}, "task", "comment", "create", "MDR-1", "--text", "Line one\nLine two");
    withTestDb(dir, (db) => {
      db.run("UPDATE comment SET created_at = ?, updated_at = ? WHERE number = 1", [Date.UTC(2026, 8, 25, 17, 42), Date.UTC(2026, 8, 25, 17, 42)]);
      db.run("UPDATE comment SET created_at = ?, updated_at = ? WHERE number = 2", [Date.UTC(2026, 8, 25, 18, 7), Date.UTC(2026, 8, 25, 18, 7)]);
    });

    // Later lines of a comment start under its text, so the indent counts the plain widths of the cells before it.
    const textIndent = " ".repeat("MDR-1#1 | 2026-09-25 19:42 +02:00 | ".length);
    const colored = run({ FORCE_COLOR: "1" }, "task", "view", "MDR-1");

    expect(colored.stderr).toBe("");
    expect(colored.stdout).toBe(
      [
        `MDR-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}High${DIM_SEPARATOR}Refine the numbers${DIM_SEPARATOR}\x1b[31mbug\x1b[39m, \x1b[34mcli\x1b[39m`,
        "",
        dim(SECTION_RULE),
        bold("Description:"),
        "First line.",
        "Second line.",
        "",
        dim(SECTION_RULE),
        bold("Relations:"),
        `Depends on${DIM_SEPARATOR}MDR-2${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}Check the totals`,
        "",
        dim(SECTION_RULE),
        bold("Comments:"),
        `MDR-1#1${DIM_SEPARATOR}${dim("2026-09-25 19:42 +02:00")}${DIM_SEPARATOR}Ready for review`,
        `MDR-1#2${DIM_SEPARATOR}${dim("2026-09-25 20:07 +02:00")}${DIM_SEPARATOR}Line one`,
        `${textIndent}Line two`,
        "",
      ].join("\n"),
    );

    const piped = [
      "MDR-1 | Backlog | High | Refine the numbers | bug, cli",
      "",
      SECTION_RULE,
      "Description:",
      "First line.",
      "Second line.",
      "",
      SECTION_RULE,
      "Relations:",
      "Depends on | MDR-2 | Backlog | Check the totals",
      "",
      SECTION_RULE,
      "Comments:",
      "MDR-1#1 | 2026-09-25 19:42 +02:00 | Ready for review",
      "MDR-1#2 | 2026-09-25 20:07 +02:00 | Line one",
      `${textIndent}Line two`,
      "",
    ].join("\n");
    expect(run({}, "task", "view", "MDR-1").stdout).toBe(piped);
    expect(run({ NO_COLOR: "1" }, "task", "view", "MDR-1").stdout).toBe(piped);
    expect(run({ FORCE_COLOR: "1" }, "task", "view", "MDR-1", "--json").stdout).not.toContain("\x1b");
  });
});

test("project view bolds its section headings, dims the separators and colors column names as task rows do, and project list dims the separator before a preview", () => {
  withIsolatedZinnDir((dir) => {
    const run = (env: Record<string, string>, ...args: Array<string>) => runZinn(args, dir, env);
    run({}, "project", "create", "MDR", "--name", "Macrodata", "--description", "First line.\nSecond line.");
    run({}, "task", "create", "MDR", "--title", "Waiting");
    run({}, "task", "create", "MDR", "--title", "Finished");
    run({}, "task", "create", "MDR", "--title", "Shelved");
    run({}, "task", "move", "MDR-2", "Done");
    run({}, "task", "archive", "MDR-3");

    // Column names are padded inside their color codes, to the plain width of the widest name.
    const columnWidth = "In Progress".length;
    expect(run({ FORCE_COLOR: "1" }, "project", "view", "MDR").stdout).toBe(
      [
        `MDR${DIM_SEPARATOR}Macrodata`,
        "",
        bold("Description:"),
        "First line.",
        "Second line.",
        "",
        bold("Columns:"),
        `\x1b[90m${"Backlog".padEnd(columnWidth)}\x1b[39m${DIM_SEPARATOR}1`,
        `${"TODO".padEnd(columnWidth)}${DIM_SEPARATOR}0`,
        `In Progress${DIM_SEPARATOR}0`,
        `${"Review".padEnd(columnWidth)}${DIM_SEPARATOR}0`,
        `\x1b[32m${"Done".padEnd(columnWidth)}\x1b[39m${DIM_SEPARATOR}1`,
        `${"Archived".padEnd(columnWidth)}${DIM_SEPARATOR}1`,
        "",
      ].join("\n"),
    );
    expect(run({ FORCE_COLOR: "1" }, "project", "list").stdout).toBe(
      `MDR${DIM_SEPARATOR}Macrodata${DIM_SEPARATOR}First line. Second line.\n`,
    );

    expect(run({}, "project", "view", "MDR").stdout).toBe(
      [
        "MDR | Macrodata",
        "",
        "Description:",
        "First line.",
        "Second line.",
        "",
        "Columns:",
        "Backlog     | 1",
        "TODO        | 0",
        "In Progress | 0",
        "Review      | 0",
        "Done        | 1",
        "Archived    | 1",
        "",
      ].join("\n"),
    );
    expect(run({}, "project", "list").stdout).toBe("MDR | Macrodata | First line. Second line.\n");
    expect(run({ FORCE_COLOR: "1" }, "project", "view", "MDR", "--json").stdout).not.toContain("\x1b");
    const columnEnvironments: Array<Record<string, string>> = [{}, { FORCE_COLOR: "1" }, { NO_COLOR: "1" }];
    for (const env of columnEnvironments) {
      const projectView = run(env, "project", "view", "MDR").stdout;
      const columnList = run(env, "project", "column", "list", "MDR").stdout;
      const columnsSection = projectView.split(env.FORCE_COLOR ? bold("Columns:") : "Columns:")[1]!;
      expect(columnsSection.trimStart()).toStartWith(columnList);
      expect(columnList).not.toContain("Archived");
    }
    expect(run({ FORCE_COLOR: "1" }, "project", "column", "edit", "MDR", "Backlog", "--name", "Backlog").stdout)
      .toBe(`MDR${DIM_SEPARATOR}${GRAY_BACKLOG}\n`);
    expect(run({ FORCE_COLOR: "1" }, "project", "column", "order", "MDR", "Done", "last").stdout)
      .toBe(`MDR${DIM_SEPARATOR}${GREEN_DONE}\n`);
    expect(run({ FORCE_COLOR: "1" }, "project", "column", "create", "MDR", "Waiting").stdout)
      .toBe(`MDR${DIM_SEPARATOR}Waiting\n`);
    expect(run({ FORCE_COLOR: "1" }, "project", "column", "list", "MDR", "--json").stdout).not.toContain("\x1b");
  });
});

test("comment lists dim the separators and timestamps, while a single comment has no timestamp to dim", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "NOTE"], dir);
    runZinn(["task", "create", "NOTE", "--title", "Commented task"], dir);
    runZinn(["task", "comment", "create", "NOTE-1", "--text", "First comment"], dir);
    runZinn(["task", "comment", "create", "NOTE-1", "--text", "Second comment"], dir);
    withTestDb(dir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 1", [Date.UTC(2026, 8, 24, 9, 5)]);
      db.run("UPDATE comment SET created_at = ? WHERE number = 2", [Date.UTC(2026, 8, 25, 17, 42)]);
    });

    const env = { TZ: "Europe/Berlin" };
    const colored = runZinn(["task", "comment", "list", "NOTE-1"], dir, { ...env, FORCE_COLOR: "1" });
    expect(colored.stdout).toBe(
      [
        `NOTE-1#1${DIM_SEPARATOR}${dim("2026-09-24 11:05 +02:00")}${DIM_SEPARATOR}First comment`,
        `NOTE-1#2${DIM_SEPARATOR}${dim("2026-09-25 19:42 +02:00")}${DIM_SEPARATOR}Second comment`,
        "",
      ].join("\n"),
    );
    expect(runZinn(["task", "comment", "list", "NOTE-1"], dir, env).stdout).toBe(
      [
        "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment",
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Second comment",
        "",
      ].join("\n"),
    );

    expect(
      runZinn(["task", "comment", "edit", "NOTE-1#2", "--text", "Edited"], dir, { FORCE_COLOR: "1" }).stdout,
    ).toBe(`NOTE-1#2${DIM_SEPARATOR}Edited\n`);
    expect(runZinn(["task", "comment", "edit", "NOTE-1#2", "--text", "Edited again"], dir).stdout).toBe(
      "NOTE-1#2 | Edited again\n",
    );
  });
});

test("task text output names labels without color words when color is off, and JSON keeps plain label names", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    runZinn(["label", "create", "bug", "--color", "red"], dir);
    runZinn(["label", "create", "docs", "--color", "cyan"], dir);
    runZinn(["project", "create", "TAGS"], dir);
    runZinn(["task", "create", "TAGS", "--title", "Tagged", "--priority", "urgent", "--label", "docs", "--label", "bug"], dir);

    const plainRow = "TAGS-1 | Backlog | U | Tagged | bug, docs\n";
    const detailRow = "TAGS-1 | Backlog | Urgent | Tagged | bug, docs\n";
    const colorOff = { FORCE_COLOR: "0" };
    const noColor = { NO_COLOR: "1" };

    // Piped, with color forced off, and with NO_COLOR in a terminal all read alike, with no color words.
    expect(runZinn(["task", "list", "TAGS"], dir).stdout).toBe(plainRow);
    expect(runZinn(["task", "list", "TAGS"], dir, colorOff).stdout).toBe(plainRow);
    expect((await runZinnInTerminal(["task", "list", "TAGS"], dir, noColor)).output).toBe(plainRow);
    expect(runZinn(["task", "view", "TAGS-1"], dir).stdout).toBe(detailRow);
    expect(runZinn(["task", "view", "TAGS-1"], dir, colorOff).stdout).toBe(detailRow);
    expect((await runZinnInTerminal(["task", "view", "TAGS-1"], dir, noColor)).output).toBe(detailRow);

    for (const args of [["task", "list", "TAGS", "--json"], ["task", "view", "TAGS-1", "--json"]]) {
      for (const env of [{}, { FORCE_COLOR: "1" }] as Array<Record<string, string>>) {
        const json = runZinn(args, dir, env).stdout;
        expect(json).not.toContain("\x1b");
        expect([JSON.parse(json)].flat()[0].labels).toEqual(["bug", "docs"]);
      }
    }
  });
});

test("label deletion confirms global removal and cancellation preserves attachments and timestamps", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    run("project", "create", "APP");
    run("label", "create", "bug");
    run("label", "create", "keep");
    run("task", "create", "APP", "--title", "First", "--label", "bug", "--label", "keep");
    run("task", "create", "APP", "--title", "Second", "--label", "bug");
    const snapshot = () => withTestDb(dir, (db) => ({
      labels: db.query("SELECT * FROM label ORDER BY id").all(),
      attachments: db.query("SELECT * FROM task_label ORDER BY task_id, label_id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
    }));
    const before = snapshot();
    const cancelled = run("label", "delete", "bug");
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain('delete label "bug" and remove it from all tasks?');
    expect(cancelled.stdout).toContain('Deletion cancelled for label "bug"');
    expect(snapshot()).toEqual(before);
    const deleted = runZinnWithConfirmation(["label", "delete", "bug"], dir);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain('Deleted label "bug"');
    expect(run("label", "list").stdout).toContain("keep");
    expect(run("label", "list").stdout).not.toContain("bug");
    expect(run("task", "view", "APP-1").stdout).toBe("APP-1 | Backlog | - | First | keep\n");
    expect(run("task", "view", "APP-2").code).toBe(0);
    withTestDb(dir, (db) => {
      expect(db.query("SELECT * FROM task_label").all()).toHaveLength(1);
      expect(db.query("SELECT * FROM task").all()).toHaveLength(2);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    const missing = run("label", "delete", "missing");
    expect(missing.code).toBe(1);
    expect(missing.stdout).not.toContain("Are you sure");
    expect(run("label", "delete", "--help").stdout).toContain("after confirmation");
  });
});

test("shared option checks reject repeated scalar flags and retain positional validation", () => {
  withIsolatedZinnDir((dir) => {
    for (const args of [
      ["label", "create", "bug", "--color", "red", "--color", "blue"],
      ["label", "create", "bug", "--description", "a", "--description", "b"],
      ["label", "edit", "bug", "--name", "a", "--name", "b"],
      ["label", "edit", "bug", "--color", "red", "--color", "blue"],
      ["label", "edit", "bug", "--description", "a", "--description", "b"],
      ["project", "create", "APP", "--name", "a", "--name", "b"],
      ["project", "edit", "APP", "--name", "a", "--name", "b"],
      ["task", "edit", "APP-1", "--title", "a", "--title", "b"],
      ["task", "relation", "create", "APP-1", "APP-2", "--type", "related", "--type", "duplicate"],
    ]) {
      const result = runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("can only be specified once");
    }
    // ? Each case lists the facts its error carries.
    const labelWordCases: Array<[string[], ...string[]]> = [
      [["label", "create"], "Usage: zinn label create"],
      [["label", "create", "one", "two"], `"two"`, "Usage: zinn label create"],
      [["label", "edit"], "Usage: zinn label edit"],
      [["label", "edit", "one", "two", "--color", "red"], `"two"`, "Usage: zinn label edit"],
    ];
    for (const [args, ...facts] of labelWordCases) {
      const result = runZinn(args, dir);
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
    }
    const extraLabel = runZinn(["label", "delete", "one", "two"], dir);
    expect(extraLabel.stderr).toContain(`"two"`);
    expect(extraLabel.stderr).toContain("Usage: zinn label delete");
  });
});

test("label edit validates changes, uniqueness, and missing labels", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    run("label", "create", "bug");
    run("label", "create", "auth");

    expect(run("label", "edit", "bug").stderr).toContain("Provide at least one field to edit");
    expect(run("label", "edit", "missing", "--color", "red").stderr).toContain("does not exist");
    expect(run("label", "edit", "BUG", "--name", "Bug").stdout).toContain("Bug");
    expect(run("label", "edit", "bug", "--name", "AUTH").stderr).toContain("already exists");
    expect(run("label", "edit", "BUG", "--name", " ").stderr).toContain("cannot be blank");
    expect(run("label", "edit", "BUG", "--color", "purple").code).toBe(1);
    expect(run("label", "list", "--json").stdout).toContain('"name": "Bug"');
    expect(run("label", "edit", "--help").stdout).toContain("Editing does not affect task attachments or task timestamps");
    expect(runZinn(["--help"], dir).stdout).toContain("label {create|list|edit|delete}");
  });
});

test("priority persists across CLI creation, editing, listing, clearing, and no-op edits", () => {
  withIsolatedZinnDir((directory) => {
    expect(runZinn(["task", "list", "--help"], directory).stdout).toContain(
      "Priority markers: - unassigned, L low, M medium, H high, U urgent.",
    );
    expect(runZinn(["project", "create", "PRI"], directory).code).toBe(0);
    expect(runZinn(["task", "create", "PRI", "--title", "Default"], directory).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ priority: string | null }, []>("SELECT priority FROM task").get()!.priority).toBeNull();
    });
    for (const [index, priority] of ["low", "medium", "high", "urgent"].entries()) {
      const created = runZinn(["task", "create", "PRI", "--title", priority, "--priority", priority], directory);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain(`| Backlog | ${priority[0]!.toUpperCase()} | ${priority}`);
      const taskKey = `PRI-${index + 2}`;
      const viewed = runZinn(["task", "view", taskKey], directory);
      expect(viewed.stdout).toBe(`${taskKey} | Backlog | ${priority[0]!.toUpperCase()}${priority.slice(1)} | ${priority}\n`);
      expect(JSON.parse(runZinn(["task", "view", taskKey, "--json"], directory).stdout).priority).toBe(priority);
    }
    expect(runZinn(["task", "list", "PRI"], directory).stdout).toBe(
      [
        `PRI-1 | Backlog | - | Default`,
        `PRI-2 | Backlog | L | low`,
        `PRI-3 | Backlog | M | medium`,
        `PRI-4 | Backlog | H | high`,
        `PRI-5 | Backlog | U | urgent`,
      ].join("\n") + "\n",
    );
    withTestDb(directory, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));
    expect(runZinn(["task", "edit", "PRI-1", "--priority", "high"], directory).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1").get()!.updated_at).toBeGreaterThan(1);
    });
    withTestDb(directory, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));
    expect(runZinn(["task", "edit", "PRI-1", "--priority", "high"], directory).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1").get()!.updated_at).toBe(1);
    });
    expect(runZinn(["task", "edit", "PRI-1", "--title", "Renamed"], directory).stdout).toBe(
      "PRI-1 | Backlog | H | Renamed\n",
    );
    expect(runZinn(["task", "list", "PRI"], directory).stdout).toContain(
      `PRI-1 | Backlog | H | Renamed`,
    );
    expect(runZinn(["task", "view", "PRI-1"], directory).stdout).toBe("PRI-1 | Backlog | High | Renamed\n");
    expect(JSON.parse(runZinn(["task", "list", "PRI", "--json"], directory).stdout)[0].priority).toBe(
      "high",
    );
    const invalid = runZinn(["task", "edit", "PRI-1", "--title", "Wrong", "--priority", "critical"], directory);
    expect(invalid.code).not.toBe(0);
    expect(runZinn(["task", "view", "PRI-1"], directory).stdout).toContain("Renamed");
    expect(runZinn(["task", "archive", "PRI-1"], directory).code).toBe(0);
    expect(runZinn(["task", "edit", "PRI-1", "--priority", "none"], directory).code).toBe(0);
    withTestDb(directory, (db) => {
      const row = db.query<{ priority: string | null; archived_at: number | null }, []>("SELECT priority, archived_at FROM task WHERE number = 1").get()!;
      expect(row.priority).toBeNull();
      expect(row.archived_at).not.toBeNull();
    });
  });
});

// --- ACTIVITY ACTOR

const AGENT_VARIABLES = ["AI_AGENT", "AGENT", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SANDBOX", "OPENCODE", "GEMINI_CLI", "CLINE_ACTIVE", "CURSOR_AGENT", "COPILOT_AGENT_SESSION_ID", "CRUSH"];

// ? Agent shells carry these variables, so each case starts from an env without them.
function runZinnAs(args: Array<string>, testDir: string, env: Record<string, string>) {
  const baseEnv: Record<string, string | undefined> = { ...process.env, ZINN_DIR: testDir, GIT_CONFIG_NOSYSTEM: "1" };
  for (const variable of AGENT_VARIABLES) {
    delete baseEnv[variable];
  }

  // ? cwd outside any repository, so only the identity file given per case applies.
  const proc = Bun.spawnSync(["bun", CLI_PATH, ...args], { cwd: testDir, env: { ...baseEnv, ...env } });
  return { stderr: proc.stderr.toString(), code: proc.exitCode };
}

function lastActor(testDir: string) {
  return withTestDb(testDir, (db) =>
    db.query<{ action: string; actor_name: string; actor_email: string | null; actor_kind: string }, []>(
      "SELECT action, actor_name, actor_email, actor_kind FROM activity ORDER BY id DESC LIMIT 1",
    ).get(),
  );
}

test("mutations record the invoking agent, then the git identity, then the OS user", () => {
  withIsolatedZinnDir((dir) => {
    const identityFile = join(dir, "gitconfig");
    writeFileSync(identityFile, "[user]\n\tname = Git Person\n\temail = git@example.com\n");

    expect(runZinnAs(["project", "create", "ACT"], dir, { AI_AGENT: "project-agent" }).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "project-agent", actor_email: null, actor_kind: "agent" });
    expect(runZinnAs(["task", "create", "ACT", "--title", "Tracked"], dir, { AI_AGENT: "test-agent_1-0" }).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "test-agent_1-0", actor_email: null, actor_kind: "agent" });

    expect(runZinnAs(["task", "move", "ACT-1", "TODO"], dir, { GIT_CONFIG_GLOBAL: identityFile }).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "move", actor_name: "Git Person", actor_email: "git@example.com", actor_kind: "human" });

    expect(runZinnAs(["task", "archive", "ACT-1"], dir, { GIT_CONFIG_GLOBAL: "/dev/null" }).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "archive", actor_name: userInfo().username, actor_email: null, actor_kind: "human" });
  });
});

// --- BACKUP

test("backup saves a copy of the database named with the UTC time and CLI version", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "BAK"], dir);
    runZinn(["task", "create", "BAK", "--title", "Saved"], dir);

    const result = runZinn(["backup", "--json"], dir);
    expect(result.code).toBe(0);

    const { path } = JSON.parse(result.stdout) as { path: string };
    expect(dirname(path)).toBe(join(dir, "backups"));
    expect(basename(path)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-/);
    expect(basename(path)).toContain(`Z-cli-${packageJson.version}-`);
    expect(basename(path)).toMatch(/-[0-9a-f]{8}\.sqlite$/);

    const backupDb = new Database(path, { readonly: true });
    try {
      expect(backupDb.query("SELECT title FROM task").all()).toEqual([{ title: "Saved" }]);
      expect(backupDb.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      backupDb.close();
    }
  });
});

test("backup refuses when there is no database and does not create one", () => {
  withIsolatedZinnDir((dir) => {
    const result = runZinn(["backup"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`There is no Zinn database at ${join(dir, "data", "zinn.sqlite")} to back up`);
    expect(existsSync(join(dir, "data"))).toBe(false);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("backup refuses a zero-byte database file without creating backups", () => {
  withIsolatedZinnDir((dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    writeFileSync(databasePath, "");

    const result = runZinn(["backup"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`There is no Zinn database at ${databasePath} to back up`);
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath).length).toBe(0);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("backup refuses a database header with no tables without creating backups", () => {
  withIsolatedZinnDir((dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    const db = new Database(databasePath);
    db.exec("PRAGMA user_version = 0");
    db.close();
    const before = readFileSync(databasePath);
    expect(before.length).toBeGreaterThan(0);

    const result = runZinn(["backup"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`There is no Zinn database at ${databasePath} to back up`);
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

// --- RESTORE

// ? A backup of a fresh store holding one task, made by the CLI, in its own directory.
function backupWithTask(dir: string, title: string) {
  runZinn(["project", "create", "RST"], dir);
  runZinn(["task", "create", "RST", "--title", title], dir);
  return (JSON.parse(runZinn(["backup", "--json"], dir).stdout) as { path: string }).path;
}

function taskTitles(dir: string) {
  return withTestDb(dir, (db) => db.query("SELECT title FROM task ORDER BY number").all());
}

function backupFiles(dir: string) {
  return existsSync(join(dir, "backups")) ? readdirSync(join(dir, "backups")).sort() : [];
}

test("restore explains recovery from damaged task and comment pages without changing the database", () => {
  for (const table of ["task", "comment"]) {
    withIsolatedZinnDir((dir) => {
      const path = backupWithTask(dir, "Kept");
      const databasePath = join(dir, "data", "zinn.sqlite");
      const { pageSize, rootPage } = withTestDb(dir, (db) => {
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        return {
          pageSize: (db.query("PRAGMA page_size").get() as { page_size: number }).page_size,
          rootPage: (db.query("SELECT rootpage FROM sqlite_schema WHERE name = ?").get(table) as { rootpage: number }).rootpage,
        };
      });
      const damaged = readFileSync(databasePath);
      const pageOffset = (rootPage - 1) * pageSize;
      damaged.fill(0, pageOffset, pageOffset + pageSize);
      writeFileSync(databasePath, damaged);
      const previousBackups = backupFiles(dir);

      const result = runZinn(["restore", path, "--yes"], dir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("database disk image is malformed");
      expect(result.stderr).toContain(`The database at ${databasePath} is damaged. Nothing was changed.`);
      expect(result.stderr).toContain("Close every program that has the database open");
      expect(result.stderr).toContain(`Move ${databasePath}, ${databasePath}-wal and ${databasePath}-shm out of the data folder`);
      expect(result.stderr).toContain("Run the same zinn restore command again");
      expect(result.stderr).not.toContain("Backups taken before each restore attempt");
      expect(readFileSync(databasePath)).toEqual(damaged);
      expect(backupFiles(dir)).toEqual(previousBackups);

      const saved = join(dir, "damaged");
      mkdirSync(saved);
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${databasePath}${suffix}`;
        if (existsSync(file)) {
          renameSync(file, join(saved, `zinn.sqlite${suffix}`));
        }
      }

      const recovered = runZinn(["restore", path, "--yes"], dir);
      expect(recovered.code).toBe(0);
      expect(recovered.stderr).toBe("");
      expect(taskTitles(dir)).toEqual([{ title: "Kept" }]);
      expect(readFileSync(join(saved, "zinn.sqlite"))).toEqual(damaged);
    });
  }
});

test("restore replaces the board after confirmation and saves the replaced board as a backup", () => {
  withIsolatedZinnDir((dir) => {
    const path = backupWithTask(dir, "Kept");
    runZinn(["task", "create", "RST", "--title", "Later"], dir);

    const result = runZinnWithConfirmation(["restore", path], dir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Replace the database at ${join(dir, "data", "zinn.sqlite")} with the backup ${path}?`);
    expect(result.stdout).toContain(`Restored the board from ${path} at schema version 1. The board it replaced was saved to ${join(dir, "backups")}/`);
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }]);

    const saved = backupFiles(dir).map((name) => join(dir, "backups", name)).filter((file) => file !== path);
    expect(saved).toHaveLength(1);
    const savedDb = new Database(saved[0]!, { readonly: true });
    try {
      expect(savedDb.query("SELECT title FROM task ORDER BY number").all()).toEqual([{ title: "Kept" }, { title: "Later" }]);
    } finally {
      savedDb.close();
    }
  });
});

test("restore keeps the board when confirmation is declined", () => {
  withIsolatedZinnDir((dir) => {
    const path = backupWithTask(dir, "Kept");
    runZinn(["task", "create", "RST", "--title", "Later"], dir);
    const backupsBefore = backupFiles(dir);

    // ? runZinn gives no stdin, so the prompt is declined.
    const result = runZinn(["restore", path], dir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Restore cancelled. The database at ${join(dir, "data", "zinn.sqlite")} is unchanged`);
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }, { title: "Later" }]);
    expect(backupFiles(dir)).toEqual(backupsBefore);
  });
});

test("restore with --json needs --yes, and with it prints the restore result", () => {
  withIsolatedZinnDir((dir) => {
    const path = backupWithTask(dir, "Kept");
    runZinn(["task", "create", "RST", "--title", "Later"], dir);
    const backupsBefore = backupFiles(dir);

    const refused = runZinn(["restore", path, "--json"], dir);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({
      error: { message: "Commands that ask for confirmation need --yes when used with --json" },
    });
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }, { title: "Later" }]);
    expect(backupFiles(dir)).toEqual(backupsBefore);

    const result = runZinn(["restore", path, "--yes", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const restored = JSON.parse(result.stdout);
    expect(restored).toEqual({
      databasePath: realpathSync(join(dir, "data", "zinn.sqlite")),
      previousVersion: 1,
      restoredVersion: 1,
      backupPath: expect.any(String),
    });
    expect(dirname(restored.backupPath)).toBe(join(dir, "backups"));
    expect(existsSync(restored.backupPath)).toBe(true);
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }]);
  });
});

test("restore refuses a file that is not a backup it can restore, printing why and changing nothing", () => {
  withIsolatedZinnDir((dir) => {
    withIsolatedZinnDir((newerDir) => {
      createBoard(dir, 1);
      const before = databaseSnapshot(dir);
      const textFile = join(newerDir, "notes.sqlite");
      writeFileSync(textFile, "not a database");
      const newer = backupWithTask(newerDir, "From the future");
      withTestDb(newerDir, (db) => db.run("PRAGMA user_version = 9"));
      const newerBackup = (JSON.parse(runZinn(["backup", "--json"], newerDir).stdout) as { path: string }).path;

      const notDatabase = runZinn(["restore", textFile, "--yes"], dir);
      expect(notDatabase.code).toBe(1);
      expect(notDatabase.stdout).toBe("");
      expect(notDatabase.stderr).toBe(
        `The file at ${textFile} is damaged or is not a SQLite database (file is not a database), so nothing was restored\n`,
      );

      // ? Without --yes, the refusal comes before the prompt.
      const newerResult = runZinn(["restore", newerBackup], dir);
      expect(newerResult.code).toBe(1);
      expect(newerResult.stdout).toBe("");
      expect(newerResult.stderr).toContain(`The backup at ${newerBackup} has schema version 9`);
      expect(newerResult.stderr).toContain(`It was made by cli ${packageJson.version}; restore it with that version or a newer one`);
      expect(newerResult.stderr).not.toContain("Backups taken before");

      const missing = runZinn(["restore", join(newerDir, "missing.sqlite"), "--yes", "--json"], dir);
      expect(missing.code).toBe(1);
      expect(JSON.parse(missing.stderr).error.message).toBe(`There is no file at ${join(newerDir, "missing.sqlite")} to restore`);

      expect(databaseSnapshot(dir)).toEqual(before);
      expect(existsSync(join(dir, "backups"))).toBe(false);
      expect(newer).not.toBe(newerBackup);
    });
  });
});

test("a refused restore onto a store with no database creates nothing", () => {
  withIsolatedZinnDir((dir) => {
    withIsolatedZinnDir((otherDir) => {
      const textFile = join(otherDir, "notes.sqlite");
      writeFileSync(textFile, "not a database");

      expect(runZinn(["restore", textFile, "--yes"], dir).code).toBe(1);
      expect(runZinn(["restore", textFile], dir).code).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});

test("restore onto a store with no database creates it from the backup", () => {
  withIsolatedZinnDir((dir) => {
    withIsolatedZinnDir((sourceDir) => {
      const path = backupWithTask(sourceDir, "Kept");

      const result = runZinn(["restore", path, "--yes"], dir);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`Restored the board from ${path} at schema version 1. There was no board to save\n`);
      expect(runZinn(["task", "list", "RST"], dir).stdout).toContain("Kept");
    });
  });
});

test("restore works on newer and unmarked databases, without --allow-legacy-read", () => {
  withIsolatedZinnDir((sourceDir) => {
    const path = backupWithTask(sourceDir, "Kept");

    for (const version of [9, 0]) {
      withIsolatedZinnDir((dir) => {
        createBoard(dir, version);

        const result = runZinn(["restore", path, "--yes", "--json"], dir);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ previousVersion: version, restoredVersion: 1 });
        expect(runZinn(["task", "list", "RST"], dir).stdout).toContain("Kept");
        expect(backupFiles(dir)).toHaveLength(1);
      });
    }
  });
});

test("restore needs exactly one backup path", () => {
  withIsolatedZinnDir((dir) => {
    const result = runZinn(["restore", "--yes"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: zinn restore");
    expect(readdirSync(dir)).toEqual([]);
  });
});

// --- MIGRATE

// ? Rows, schema and version, to prove a refused migrate wrote nothing.
function databaseSnapshot(dir: string) {
  return withTestDb(dir, (db) => ({
    version: db.query("PRAGMA user_version").get(),
    schema: db.query("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
    projects: db.query("SELECT * FROM project").all(),
    tasks: db.query("SELECT * FROM task").all(),
  }));
}

function createBoard(dir: string, version: number) {
  runZinn(["project", "create", "MIG"], dir);
  runZinn(["task", "create", "MIG", "--title", "Kept"], dir);
  withTestDb(dir, (db) => db.run(`PRAGMA user_version = ${version}`));
}

test("migrate refuses when there is no database and creates no files", () => {
  withIsolatedZinnDir((dir) => {
    const result = runZinn(["migrate"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("There is no Zinn database with data");
    expect(result.stderr).not.toContain("Backups taken before");
    expect(readdirSync(dir)).toEqual([]);
  });
});

test("migrate refuses an empty database", () => {
  withIsolatedZinnDir((dir) => {
    mkdirSync(join(dir, "data"));
    new Database(join(dir, "data", "zinn.sqlite")).close();
    const before = readFileSync(join(dir, "data", "zinn.sqlite"));
    const result = runZinn(["migrate"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("There is no Zinn database with data");
    expect(readFileSync(join(dir, "data", "zinn.sqlite"))).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate refuses an unmarked database, with or without --allow-legacy-read, and changes nothing", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 0);
    const before = databaseSnapshot(dir);
    const result = runZinn(["migrate", "--json"], dir);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.message).toContain("has no schema version");
    expect(JSON.parse(result.stderr).error.message).toContain("adopted as version 1");
    expect(runZinn(["migrate", "--allow-legacy-read"], dir).code).toBe(1);
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate refuses a newer database and reports both versions and the CLI version", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 9);
    const before = databaseSnapshot(dir);
    const result = runZinn(["migrate"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("schema version 9");
    expect(result.stderr).toContain(`cli ${packageJson.version}) reaches only version 1`);
    expect(result.stderr).not.toContain("Backups taken before");
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate on a current database is a no-op with no backup", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 1);
    const before = databaseSnapshot(dir);

    const result = runZinn(["migrate", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      databasePath: join(dir, "data", "zinn.sqlite"),
      previousVersion: 1,
      finalVersion: 1,
      changed: false,
      backupPath: null,
    });
    expect(runZinn(["migrate"], dir).stdout).toBe("The database is already at schema version 1\n");
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

// --- REINDEX (ZINN-49)

test("reindex rebuilds a missing search index from the tasks and comments, archived ones included", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "IDX"], dir);
    runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
    runZinn(["task", "create", "IDX", "--title", "Gadget export"], dir);
    runZinn(["task", "comment", "create", "IDX-1", "--text", "Needs a spinner"], dir);
    runZinn(["task", "archive", "IDX-2"], dir);
    const before = databaseSnapshot(dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_search"));

    expect(runZinn(["task", "search", "spinner"], dir).code).toBe(1);

    const result = runZinn(["reindex", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      databasePath: join(realpathSync(dir), "data", "zinn.sqlite"),
      taskCount: 2,
    });
    expect(runZinn(["task", "search", "spinner"], dir).stdout).toContain("IDX-1");
    expect(runZinn(["task", "search", "gadget", "--archived"], dir).stdout).toContain("IDX-2");
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);

    expect(runZinn(["reindex"], dir).stdout).toBe("Rebuilt the search index from 2 tasks\n");
  });
});

test("a missing search index points search and index-updating writes at reindex, changing nothing", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "IDX"], dir);
    runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_search"));
    const countRows = () =>
      withTestDb(dir, (db) =>
        db.query("SELECT (SELECT COUNT(*) FROM comment) AS comments, (SELECT COUNT(*) FROM activity) AS activities").get(),
      );
    const before = { snapshot: databaseSnapshot(dir), rows: countRows() };

    for (const args of [
      ["task", "search", "widget"],
      ["task", "create", "IDX", "--title", "Refused"],
      ["task", "comment", "create", "IDX-1", "--text", "Refused"],
    ]) {
      const plain = runZinn(args, dir);
      expect(plain.code).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toBe("no such table: task_search. Run `zinn reindex` to rebuild the search index.\n");

      const json = runZinn([...args, "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      expect(JSON.parse(json.stderr).error.message).toBe(
        "no such table: task_search. Run `zinn reindex` to rebuild the search index.",
      );
    }
    expect({ snapshot: databaseSnapshot(dir), rows: countRows() }).toEqual(before);
  });
});

test("a missing table other than the search index gets no reindex hint", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "IDX"], dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_label; DROP TABLE label"));
    const result = runZinn(["label", "list"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no such table: label");
    expect(result.stderr).not.toContain("reindex");
  });
});

test("reindex refuses when there is no database and creates no files", () => {
  withIsolatedZinnDir((dir) => {
    const result = runZinn(["reindex"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`There is no Zinn database at ${join(dir, "data", "zinn.sqlite")}`);
    expect(readdirSync(dir)).toEqual([]);
  });
});

test("reindex refuses an empty database file and leaves it empty", () => {
  withIsolatedZinnDir((dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    writeFileSync(databasePath, "");
    const result = runZinn(["reindex"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`There is no Zinn database at ${databasePath}`);
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath).length).toBe(0);
  });
});

test("reindex refuses a newer database and leaves it unchanged", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 9);
    const before = databaseSnapshot(dir);
    const result = runZinn(["reindex"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is read-only");
    expect(result.stderr).toContain("schema version 9");
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

// --- READ-ONLY DATABASES (ZINN-118)

test("a newer database refuses changes, naming both versions and this CLI, while reads still work", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 9);
    const before = databaseSnapshot(dir);

    const list = runZinn(["task", "list", "MIG"], dir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("Kept");

    const created = runZinn(["task", "create", "MIG", "--title", "Refused"], dir);
    expect(created.code).toBe(1);
    expect(created.stdout).toBe("");
    expect(created.stderr).toContain(`The database at ${join(dir, "data", "zinn.sqlite")} is read-only`);
    expect(created.stderr).toContain("schema version 9");
    expect(created.stderr).toContain("reaches only version 1");
    expect(created.stderr).toContain(`cli ${packageJson.version}, run from ${CLI_PATH}`);
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("task delete on a read-only database refuses before asking for confirmation", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 9);
    const before = databaseSnapshot(dir);
    const result = runZinnWithConfirmation(["task", "delete", "MIG-1"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("is read-only");
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("an unmarked database is refused, for reads and writes, and left unchanged", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 0);
    const before = databaseSnapshot(dir);

    for (const args of [["task", "list", "MIG"], ["task", "create", "MIG", "--title", "Refused"]]) {
      const result = runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`The database at ${join(dir, "data", "zinn.sqlite")} has no schema version`);
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

// --- LEGACY READS (ZINN-119)

const LEGACY_FLAG = "--allow-legacy-read";

function warningLines(stderr: string) {
  return stderr.split("\n").filter((line) => line.includes("no schema version"));
}

test("--allow-legacy-read reads an unmarked database with one warning on stderr, each invocation needing it again", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 0);
    const before = databaseSnapshot(dir);
    const databasePath = join(dir, "data", "zinn.sqlite");

    for (const args of [["task", "list", "MIG", LEGACY_FLAG], [LEGACY_FLAG, "project", "list"], ["task", "view", "MIG-1", LEGACY_FLAG]]) {
      const allowed = runZinn(args, dir);
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toContain("MIG");
      expect(warningLines(allowed.stderr)).toHaveLength(1);
      expect(allowed.stderr).toContain(databasePath);
    }

    const refused = runZinn(["task", "list", "MIG"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(LEGACY_FLAG);
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("--allow-legacy-read with --json keeps stdout parseable and refusals as a JSON error", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 0);

    const allowed = runZinn(["task", "list", "MIG", "--json", LEGACY_FLAG], dir);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toHaveLength(1);
    expect(warningLines(allowed.stderr)).toHaveLength(1);

    const refused = runZinn(["task", "list", "MIG", "--json"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr).error.message).toContain(LEGACY_FLAG);
  });
});

test("a --allow-legacy-read after -- is command input, so the database stays refused", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 0);
    const before = databaseSnapshot(dir);
    const result = runZinn(["task", "search", "--", LEGACY_FLAG], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("has no schema version");
    expect(result.stderr).not.toContain("Warning:");
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("--allow-legacy-read never lets a command change an unmarked database", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 0);
    const before = databaseSnapshot(dir);
    const attempts = [
      ["task", "create", "MIG", "--title", "Refused"],
      ["task", "edit", "MIG-1", "--title", "Refused"],
      ["task", "delete", "MIG-1", "--yes"],
      ["project", "create", "NEW"],
    ];

    for (const args of attempts) {
      const result = runZinn([...args, LEGACY_FLAG], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("is read-only");
      expect(result.stderr).toContain("open for reading only");
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("--allow-legacy-read does not warn about a database that has a schema version", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 1);
    const current = runZinn(["task", "list", "MIG", LEGACY_FLAG], dir);
    expect(current.code).toBe(0);
    expect(current.stderr).toBe("");

    withTestDb(dir, (db) => db.run("PRAGMA user_version = 9"));
    const newer = runZinn(["task", "list", "MIG", LEGACY_FLAG], dir);
    expect(newer.code).toBe(0);
    expect(newer.stderr).toBe("");
  });
});

test("help, --version and backup need no --allow-legacy-read for an unmarked database", () => {
  withIsolatedZinnDir((dir) => {
    createBoard(dir, 0);
    const before = databaseSnapshot(dir);

    expect(runZinn(["--help"], dir).stdout).toContain(LEGACY_FLAG);
    expect(runZinn(["--version"], dir).code).toBe(0);

    const backup = runZinn(["backup", "--json"], dir);
    expect(backup.code).toBe(0);
    expect(backup.stderr).toBe("");
    expect(existsSync(JSON.parse(backup.stdout).path)).toBe(true);
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("help and --version open no database, not even one that core refuses", () => {
  withIsolatedZinnDir((dir) => {
    const commands = [["--version"], ["--help"], ["task", "--help"], ["task", "create", "--help"]];

    for (const args of commands) {
      expect(runZinn(args, dir).code).toBe(0);
    }
    expect(readdirSync(dir)).toEqual([]);

    createBoard(dir, 0);
    const before = databaseSnapshot(dir);
    for (const args of commands) {
      const result = runZinn(args, dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("simultaneous backup commands create distinct valid snapshots", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    expect(runZinn(["project", "create", "BAK"], dir).code).toBe(0);
    expect(runZinn(["task", "create", "BAK", "--title", "Saved"], dir).code).toBe(0);

    const results = await Promise.all(Array.from({ length: 4 }, () => runZinnAsync(["backup", "--json"], dir)));
    const paths = new Set<string>();
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const { path } = JSON.parse(result.stdout) as { path: string };
      expect(paths.has(path)).toBe(false);
      paths.add(path);
      const snapshot = new Database(path, { readonly: true });
      try {
        expect(snapshot.query("SELECT title FROM task").all()).toEqual([{ title: "Saved" }]);
        expect(snapshot.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshot.close();
      }
    }
  });
});


test("all CLI descriptions normalize blank input and preserve meaningful formatting", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect(run("project", "create", "APP").code).toBe(0);
    const entities = [
      { type: "project", create: ["EMPTY"], editKey: "EMPTY", read: ["project", "view", "EMPTY"] },
      { type: "task", create: ["APP", "--title", "Empty"], editKey: "APP-1", read: ["task", "view", "APP-1"] },
      { type: "label", create: ["empty"], editKey: "empty", read: ["label", "list"] },
    ];

    for (const entity of entities) {
      const created = run(entity.type, "create", ...entity.create, "--description", " \n\t ", "--json");
      expect(created.code).toBe(0);
      expect(JSON.parse(created.stdout).description).toBeNull();
      for (const clearInput of ["", " \n\t "]) {
        const description = "  Details\n\tIndented  \n";
        const edited = run(entity.type, "edit", entity.editKey, "--description", description, "--json");
        expect(edited.code).toBe(0);
        expect(JSON.parse(edited.stdout).description).toBe(description);
        const cleared = run(entity.type, "edit", entity.editKey, "--description", clearInput, "--json");
        expect(cleared.code).toBe(0);
        expect(JSON.parse(cleared.stdout).description).toBeNull();
      }
      const result = JSON.parse(run(...entity.read, "--json").stdout);
      expect((Array.isArray(result) ? result[0] : result).description).toBeNull();
    }

    expect(JSON.parse(run("project", "create", "OMITTED", "--json").stdout).description).toBeNull();
    expect(JSON.parse(run("task", "create", "APP", "--title", "Omitted", "--json").stdout).description).toBeNull();
    expect(JSON.parse(run("label", "create", "omitted", "--json").stdout).description).toBeNull();
  });
});

test("project descriptions flow through creation, partial edits, view, list and clearing", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "Purpose\nMore context";
    const created = run("project", "create", "DESC", "--description", description, "--json");
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ key: "DESC", name: "DESC", description });
    expect(run("project", "view", "DESC").stdout).toStartWith(`DESC | DESC\n\nDescription:\n${description}\n\nColumns:\n`);
    expect(run("project", "list").stdout).toBe("DESC | DESC | Purpose More context\n");
    expect(JSON.parse(run("project", "list", "--json").stdout)[0].description).toBe(description);
    expect(JSON.parse(run("project", "edit", "DESC", "--name", "Renamed", "--json").stdout).description).toBe(description);
    expect(JSON.parse(run("project", "edit", "DESC", "--description", "Updated", "--json").stdout)).toEqual({ key: "DESC", name: "Renamed", description: "Updated" });
    expect(run("project", "edit", "DESC", "--description", "").stdout).toBe("DESC | Renamed\n");
    expect(JSON.parse(run("project", "view", "DESC", "--json").stdout).description).toBeNull();
    expect(run("project", "edit", "DESC", "--description", "a", "--description", "b").code).toBe(1);
  });
});


test("project list and write rows show truncated description previews, project view and JSON keep full text, and task rows leave descriptions out", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "  Context\n" + "x".repeat(200);
    const preview = `Context ${"x".repeat(71)}…`;
    expect(preview).toHaveLength(80);
    const taskProject = JSON.parse(run("project", "create", "PRE", "--description", description, "--json").stdout);
    run("task", "create", "PRE", "--title", "Task", "--description", description);
    expect(run("task", "list", "PRE").stdout).toBe("PRE-1 | Backlog | - | Task\n");
    expect(run("project", "list").stdout).toBe(`PRE | PRE | ${preview}\n`);
    expect(run("project", "view", "PRE").stdout).toStartWith(`PRE | PRE\n\nDescription:\n${description}\n\nColumns:\n`);
    expect(run("project", "edit", "PRE", "--description", description).stdout).toBe(`PRE | PRE | ${preview}\n`);
    expect(taskProject.description).toBe(description);
    expect(JSON.parse(run("project", "view", "PRE", "--json").stdout).description).toBe(description);
    expect(run("project", "edit", "PRE", "--description", " \n ").stdout).toBe("PRE | PRE\n");
  });
});

// --- CONCURRENCY (ZINN-68)

test("concurrent fresh initialization supports readers and project creators", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    for (const operation of ["list", "create"]) {
      for (let round = 0; round < 3; round++) {
        const store = join(dir, `${operation}-${round}`);
        const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
          runZinnAsync(operation === "list"
            ? ["project", "list", "--json"]
            : ["project", "create", `P${index}`, "--json"], store),
        ));

        for (const result of results) {
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        }
        withTestDb(store, (db) => {
          const expectedProjects = operation === "create" ? 40 : 0;
          expect(db.query("SELECT COUNT(*) AS count FROM project").get()).toEqual({ count: expectedProjects });
          expect(db.query("SELECT COUNT(*) AS count FROM project_column").get()).toEqual({ count: expectedProjects * 5 });
          expect(db.query("SELECT COUNT(*) AS count FROM activity").get()).toEqual({ count: expectedProjects });
          expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
          expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        });
      }
    }
  });
}, 60_000);

test("concurrent task and comment writes preserve results, counters, order, activity and search", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    expect(runZinn(["project", "create", "BEN"], dir).code).toBe(0);
    expect(runZinn(["task", "create", "BEN", "--title", "comment-target"], dir).code).toBe(0);
    const taskKeys = ["BEN-1"];
    const commentKeys: Array<string> = [];
    const titles = ["comment-target"];
    const comments: Array<string> = [];

    for (let round = 0; round < 3; round++) {
      const operations = [
        ...Array.from({ length: 40 }, (_, index) => ({ kind: "task", token: `task${round}n${index}` })),
        ...Array.from({ length: 40 }, (_, index) => ({ kind: "comment", token: `comment${round}n${index}` })),
        ...Array.from({ length: 20 }, () => ({ kind: "read", token: "" })),
      ];
      const results = await Promise.all(operations.map(async ({ kind, token }) => {
        const args = kind === "task" ? ["task", "create", "BEN", "--title", token, "--json"]
          : kind === "comment" ? ["task", "comment", "create", "BEN-1", "--text", token, "--json"]
          : ["task", "list", "BEN", "--json"];
        return { kind, token, ...await runZinnAsync(args, dir) };
      }));

      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        const data = JSON.parse(result.stdout);
        if (result.kind === "task") {
          taskKeys.push(data.key);
          titles.push(result.token);
        } else if (result.kind === "comment") {
          commentKeys.push(data.key);
          comments.push(result.token);
        } else {
          expect(Array.isArray(data)).toBe(true);
        }
      }
    }

    expect(new Set(taskKeys).size).toBe(titles.length);
    expect(new Set(commentKeys).size).toBe(comments.length);
    withTestDb(dir, (db) => {
      const tasks = db.query<{ id: string; number: number; title: string; task_order: string; comment_count: number }, []>(
        "SELECT id, number, title, task_order, comment_count FROM task ORDER BY number",
      ).all();
      const storedComments = db.query<{ number: number; text: string }, []>(
        "SELECT number, text FROM comment ORDER BY number",
      ).all();
      expect(tasks.map((task) => task.title).sort()).toEqual([...titles].sort());
      expect(tasks.map((task) => task.number)).toEqual(Array.from({ length: titles.length }, (_, index) => index + 1));
      expect(new Set(tasks.map((task) => task.task_order)).size).toBe(tasks.length);
      expect(storedComments.map((comment) => comment.text).sort()).toEqual([...comments].sort());
      expect(storedComments.map((comment) => comment.number)).toEqual(Array.from({ length: comments.length }, (_, index) => index + 1));
      expect(tasks[0]!.comment_count).toBe(comments.length);
      expect(db.query("SELECT task_count FROM project WHERE key = 'BEN'").get()).toEqual({ task_count: tasks.length });
      expect(db.query("SELECT COUNT(*) AS count FROM activity WHERE entity_type = 'task' AND action = 'create'").get()).toEqual({ count: tasks.length });
      expect(db.query("SELECT COUNT(*) AS count FROM activity WHERE action = 'comment_create'").get()).toEqual({ count: comments.length });
      expect(db.query("SELECT COUNT(*) AS count FROM task_search").get()).toEqual({ count: tasks.length });

      for (const task of tasks) {
        expect(db.query("SELECT title FROM task_search WHERE task_id = ?").get(task.id)).toEqual({ title: task.title });
      }
      for (const token of comments) {
        expect(db.query("SELECT task_id FROM task_search WHERE task_search MATCH ?").all(token)).toEqual([{ task_id: tasks[0]!.id }]);
      }
      expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
}, 60_000);

test("a CLI writer waits for a held lock and succeeds after release", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    expect(runZinn(["project", "create", "WAIT"], dir).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();
    const release = setTimeout(() => db.run("ROLLBACK"), 250);

    try {
      const result = await runZinnAsync(["task", "create", "WAIT", "--title", "waited", "--json"], dir);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).key).toBe("WAIT-1");
      expect(performance.now() - began).toBeGreaterThanOrEqual(250);
      expect(db.query("SELECT title FROM task").all()).toEqual([{ title: "waited" }]);
    } finally {
      clearTimeout(release);
      if (db.inTransaction) {
        db.run("ROLLBACK");
      }
      db.close();
    }
  });
}, 45_000);

test("persistent contention times out without a partial CLI mutation", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    expect(runZinn(["project", "create", "LOCK"], dir).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();

    try {
      const result = await runZinnAsync(["task", "create", "LOCK", "--title", "must not persist", "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.message).toContain("database is locked");
      expect(performance.now() - began).toBeGreaterThanOrEqual(29_000);
      expect(performance.now() - began).toBeLessThan(40_000);
      expect(db.query("SELECT COUNT(*) AS count FROM task").get()).toEqual({ count: 0 });
      expect(db.query("SELECT task_count FROM project WHERE key = 'LOCK'").get()).toEqual({ task_count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM task_search").get()).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM activity").get()).toEqual({ count: 1 });
    } finally {
      db.run("ROLLBACK");
      db.close();
    }
  });
}, 45_000);

test("CLI initialization errors expose the underlying message and code", () => {
  withIsolatedZinnDir((dir) => {
    mkdirSync(join(dir, "data"));
    const contents = "not a SQLite database";
    const path = join(dir, "data", "zinn.sqlite");
    writeFileSync(path, contents);
    const result = runZinn(["project", "list", "--json"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.message).toContain("There was a problem initializing Zinn:");
    expect(JSON.parse(result.stderr).error.message).toContain("file is not a database (SQLITE_NOTADB)");
    expect(readFileSync(path, "utf8")).toBe(contents);
  });
});

// --- SETTINGS (ZINN-56)

// ? Runs the bin from cwd with ZINN_DIR unset and a temporary HOME inside testDir, so the settings files choose the store.
function runZinnFrom(args: Array<string>, testDir: string, cwd: string) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: join(testDir, "home") };
  delete env.ZINN_DIR;
  const proc = Bun.spawnSync(["bun", CLI_PATH, ...args], { cwd, env });

  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), code: proc.exitCode };
}

/** A repository inside testDir holding a zinn.local.json with the given content. */
function repositoryWithSettings(testDir: string, content: string) {
  const repository = join(testDir, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(join(testDir, "home"));
  writeFileSync(join(repository, "zinn.local.json"), content);

  return repository;
}

test("storage.directory in zinn.local.json chooses the store, from any folder of the repository", () => {
  withIsolatedZinnDir((dir) => {
    const repository = repositoryWithSettings(dir, JSON.stringify({ storage: { directory: "../store" } }));
    const nested = join(repository, "src");
    mkdirSync(nested);

    expect(runZinnFrom(["project", "create", "SET"], dir, repository).code).toBe(0);
    expect(runZinnFrom(["project", "list", "--json"], dir, nested).stdout).toContain('"key": "SET"');
    expect(withTestDb(join(dir, "store"), (db) => db.query("SELECT key FROM project").all())).toEqual([{ key: "SET" }]);
    expect(existsSync(join(dir, "home", ".zinn"))).toBe(false);
  });
});

test("an invalid zinn.local.json fails the command with the file's path, without a stack trace, before creating a store", () => {
  withIsolatedZinnDir((dir) => {
    const repository = repositoryWithSettings(dir, JSON.stringify({ storage: { directory: 42 } }));
    const settingsPath = join(realpathSync(repository), "zinn.local.json");

    const result = runZinnFrom(["project", "create", "SET"], dir, repository);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith(`Cannot use settings file ${settingsPath}: it has invalid settings\n`);
    expect(result.stderr).toContain("storage.directory");
    expect(result.stderr).not.toContain("    at ");
    expect(existsSync(join(dir, "home", ".zinn"))).toBe(false);
    expect(readdirSync(repository).sort()).toEqual([".git", "zinn.local.json"]);
  });
});

// --- PARTIAL TEXT EDITS (ZINN-177)

// ? Creates project APP with task APP-1, label bug and comment APP-1#1, all with the given text.
function seedEditableText(dir: string, text: string) {
  const run = (...args: string[]) => runZinn(args, dir);
  expect(run("project", "create", "APP", "--description", text).code).toBe(0);
  expect(run("task", "create", "APP", "--title", "Task", "--description", text).code).toBe(0);
  expect(run("label", "create", "bug", "--description", text).code).toBe(0);
  expect(run("task", "comment", "create", "APP-1", "--text", text).code).toBe(0);

  return run;
}

const storedTextOf = (dir: string) =>
  withTestDb(dir, (db) => ({
    project: db.query<{ text: string | null }, []>("SELECT description AS text FROM project").get()!.text,
    task: db.query<{ text: string | null }, []>("SELECT description AS text FROM task").get()!.text,
    label: db.query<{ text: string | null }, []>("SELECT description AS text FROM label").get()!.text,
    comment: db.query<{ text: string }, []>("SELECT text FROM comment").get()!.text,
  }));

test("--append adds a paragraph to a task description and to a comment's text", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "First.\n");

    expect(run("task", "edit", "APP-1", "--description", "Second.", "--append").code).toBe(0);
    expect(run("task", "comment", "edit", "APP-1#1", "--text", "More.", "--append").code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ task: "First.\n\nSecond.", comment: "First.\n\nMore." });
  });
});

test("--replacing swaps one passage in a project description and in a label description", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "old sentence, kept");

    expect(run("project", "edit", "APP", "--description", "new", "--replacing", "old sentence").code).toBe(0);
    expect(run("label", "edit", "bug", "--description", "fresh", "--replacing", "old sentence").code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ project: "new, kept", label: "fresh, kept" });
  });
});

test("--replacing --all replaces every match and prints the edited object as any edit does", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "board and board");

    const edited = run("project", "edit", "APP", "--description", "database", "--replacing", "board", "--all");
    expect(edited.code).toBe(0);
    expect(edited.stdout).toContain("database and database");
    expect(storedTextOf(dir).project).toBe("database and database");

    const comment = run("task", "comment", "edit", "APP-1#1", "--text", "x", "--replacing", "board", "--all");
    expect(comment.code).toBe(0);
    expect(comment.stdout).toContain("x and x");
  });
});

test("--replacing with several matches and no --all fails with the --all hint and changes nothing", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "dup dup");
    const before = storedTextOf(dir);

    const attempts = [
      run("task", "edit", "APP-1", "--description", "x", "--replacing", "dup"),
      run("project", "edit", "APP", "--description", "x", "--replacing", "dup"),
      run("task", "comment", "edit", "APP-1#1", "--text", "x", "--replacing", "dup"),
    ];

    for (const attempt of attempts) {
      expect(attempt.code).toBe(1);
      expect(attempt.stdout).toBe("");
      expect(attempt.stderr).toContain("matches 2 places");
      expect(attempt.stderr).toEndWith(" Use --all to replace every match.\n");
    }
    expect(storedTextOf(dir)).toEqual(before);
  });
});

test("--replacing with no match fails without the --all hint and changes nothing", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "Some Text");
    const before = storedTextOf(dir);

    const attempts = [
      run("task", "edit", "APP-1", "--description", "x", "--replacing", "some text"),
      run("label", "edit", "bug", "--description", "x", "--replacing", "absent"),
    ];

    for (const attempt of attempts) {
      expect(attempt.code).toBe(1);
      expect(attempt.stderr).toContain("The text to replace was not found in");
      expect(attempt.stderr).not.toContain("--all");
    }
    expect(storedTextOf(dir)).toEqual(before);
  });
});

test("an empty text with --replacing deletes the match", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "keep\nstale line\n");

    expect(run("task", "edit", "APP-1", "--description", "", "--replacing", "stale line\n").code).toBe(0);
    expect(run("task", "comment", "edit", "APP-1#1", "--text", "", "--replacing", "\nstale line").code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ task: "keep\n", comment: "keep\n" });
  });
});

test("a modifier edit with --json carries the full resulting text", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "One.");

    const task = JSON.parse(run("task", "edit", "APP-1", "--description", "Two.", "--append", "--json").stdout);
    const comment = JSON.parse(run("task", "comment", "edit", "APP-1#1", "--text", "Two.", "--append", "--json").stdout);

    expect(task.description).toBe("One.\n\nTwo.");
    expect(comment.text).toBe("One.\n\nTwo.");
  });
});

test("a match error with --json uses the usual error shape, with the hint for several matches", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "dup dup");

    const several = run("task", "edit", "APP-1", "--description", "x", "--replacing", "dup", "--json");
    const none = run("task", "edit", "APP-1", "--description", "x", "--replacing", "absent", "--json");

    expect(several.code).toBe(1);
    expect(JSON.parse(several.stderr)).toEqual({
      error: {
        message:
          "The text to replace matches 2 places in APP-1's description. Include more of the surrounding text so it matches one place. Use --all to replace every match.",
      },
    });
    expect(JSON.parse(none.stderr)).toEqual({
      error: { message: "The text to replace was not found in APP-1's description." },
    });
  });
});

test("the text-edit flags are usage errors without the text flag or in an invalid combination", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "text");
    const before = storedTextOf(dir);

    const cases: Array<[Array<string>, string]> = [
      [["task", "edit", "APP-1", "--append"], 'Option "--append" needs "--description"'],
      [["project", "edit", "APP", "--name", "New", "--replacing", "a"], 'Option "--replacing" needs "--description"'],
      [["label", "edit", "bug", "--color", "red", "--append"], 'Option "--append" needs "--description"'],
      [["task", "comment", "edit", "APP-1#1", "--replacing", "a"], 'Option "--replacing" needs "--text"'],
      [["task", "edit", "APP-1", "--description", "x", "--all"], 'Option "--all" needs "--replacing"'],
      [["task", "comment", "edit", "APP-1#1", "--text", "x", "--all"], 'Option "--all" needs "--replacing"'],
      [["task", "edit", "APP-1", "--description", "x", "--append", "--replacing", "t"], 'Option "--append" cannot be used with "--replacing"'],
      [["task", "comment", "edit", "APP-1#1", "--text", "x", "--append", "--replacing", "t"], 'Option "--append" cannot be used with "--replacing"'],
    ];

    for (const [args, message] of cases) {
      const result = run(...args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`${message}\n`);
    }
    expect(storedTextOf(dir)).toEqual(before);
    expect(JSON.parse(run("task", "edit", "APP-1", "--append", "--json").stderr)).toEqual({
      error: { message: 'Option "--append" needs "--description"' },
    });
  });
});

test("core's value rules for the text-edit flags surface as plain messages", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "text");

    const blankAppend = run("task", "edit", "APP-1", "--description", " ", "--append");
    const emptyFind = run("task", "edit", "APP-1", "--description", "x", "--replacing", "");
    const blankComment = run("task", "comment", "edit", "APP-1#1", "--text", "", "--replacing", "text");

    expect(blankAppend.stderr).toBe("Text to append cannot be blank\n");
    expect(emptyFind.stderr).toBe("Text to find cannot be empty\n");
    expect(blankComment.stderr).toBe("Comment text cannot be blank\n");
  });
});

test("the text-edit flags are limited to the edit commands and listed in their help", () => {
  withIsolatedZinnDir((dir) => {
    const run = seedEditableText(dir, "text");

    expect(run("task", "create", "APP", "--title", "T", "--append").code).toBe(1);
    expect(run("task", "comment", "create", "APP-1", "--text", "x", "--append").code).toBe(1);

    for (const command of [["task", "edit"], ["project", "edit"], ["label", "edit"], ["task", "comment", "edit"]]) {
      const help = run(...command, "--help").stdout;
      expect(help).toContain("[--append|--replacing <old> [--all]]");
      expect(help).toContain("--append");
    }
  });
});

// --- ACTIVITY

test("task view history opts into shared activity previews and full JSON without writes", () => {
  withIsolatedZinnDir((directory) => {
    const run = (...args: Array<string>) => {
      const result = runZinn(args, directory);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    run("project", "create", "APP");
    run("task", "create", "APP", "--title", "Inspected task");
    run("task", "create", "APP", "--title", "Other task");
    run("task", "edit", "APP-1", "--description", "Full\nrecorded description");
    run("task", "order", "APP-1", "bottom");
    run("task", "move", "APP-1", "In Progress");
    const originalComment = "Original comment text\n" + "Previous content. ".repeat(20);
    run("task", "comment", "create", "APP-1", "--text", originalComment);
    run("task", "comment", "edit", "APP-1#1", "--text", "Current comment");
    run("task", "comment", "create", "APP-1", "--text", "Deleted comment");
    run("task", "comment", "delete", "APP-1#2", "--yes");
    run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    run("task", "relation", "delete", "APP-1", "APP-2", "--type", "related");
    run("task", "archive", "APP-1");
    run("task", "unarchive", "APP-1");

    const events: Array<Activity> = JSON.parse(run("activity", "list", "--task", "APP-1", "--json"));
    expect(events.find((event) => event.action === "order")).toBeDefined();
    expect(events.find((event) => event.action === "comment_delete")?.changes?.comment).toMatchObject({
      key: "APP-1#2", text: "Deleted comment",
    });
    expect(events.find((event) => event.action === "comment_edit")?.changes?.text).toEqual([
      originalComment, "Current comment",
    ]);

    const ordinaryText = run("task", "view", "APP-1");
    const ordinaryJson = JSON.parse(run("task", "view", "APP-1", "--json"));
    expect(ordinaryJson).not.toHaveProperty("activity");
    const historyJson = JSON.parse(run("task", "view", "app-1", "--history", "--json"));
    expect(historyJson).toEqual({ ...ordinaryJson, activity: events });
    expect(historyJson.comments).toHaveLength(1);
    expect(historyJson.comments[0].text).toBe("Current comment");
    expect(historyJson.comments[0]).not.toHaveProperty("activity");

    const previews = run("activity", "list", "--task", "APP-1");
    const historyText = run("task", "view", "APP-1", "--history");
    expect(historyText.startsWith(ordinaryText.trimEnd())).toBe(true);
    expect(historyText.endsWith(previews)).toBe(true);
    expect(historyText).not.toContain(originalComment);
    const commentEdit = events.find((event) => event.action === "comment_edit")!;
    expect(run("activity", "view", commentEdit.id)).toContain(originalComment);
    expect(JSON.parse(run("activity", "list", "--task", "APP-1", "--json"))).toEqual(events);
    expect(JSON.parse(run("task", "view", "APP-1", "--json"))).toEqual(ordinaryJson);
  });
});

test("task view only reads history when requested and includes an empty activity array", () => {
  withIsolatedZinnDir((directory) => {
    expect(runZinn(["project", "create", "APP"], directory).code).toBe(0);
    expect(runZinn(["task", "create", "APP", "--title", "Before recording"], directory).code).toBe(0);
    const taskId = withTestDb(directory, (db) => {
      db.run("DELETE FROM activity");
      return db.query<{ id: string }, []>("SELECT id FROM task").get()!.id;
    });
    const ordinary = runZinn(["task", "view", "APP-1", "--json"], directory);
    expect(ordinary.code).toBe(0);
    const requested = runZinn(["task", "view", "APP-1", "--history", "--json"], directory);
    expect(requested.code).toBe(0);
    expect(JSON.parse(requested.stdout)).toEqual({ ...JSON.parse(ordinary.stdout), activity: [] });
    expect(runZinn(["task", "view", "APP-1", "--history"], directory)).toEqual(
      runZinn(["task", "view", "APP-1"], directory),
    );

    seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-000000000001", entity_id: taskId }]);
    withTestDb(directory, (db) => db.run("UPDATE activity SET changes = 'invalid JSON'"));
    expect(runZinn(["task", "view", "APP-1", "--json"], directory)).toEqual(ordinary);
    expect(runZinn(["task", "view", "APP-1"], directory).code).toBe(0);
    expect(runZinn(["task", "view", "APP-1", "--history", "--json"], directory).code).toBe(1);
  });
});

test("task view history orders timestamp ties and preserves full records for only its task", () => {
  withIsolatedZinnDir((directory) => {
    expect(runZinn(["project", "create", "APP"], directory).code).toBe(0);
    expect(runZinn(["task", "create", "APP", "--title", "Current task"], directory).code).toBe(0);
    const taskId = withTestDb(directory, (db) => {
      db.run("DELETE FROM activity");
      return db.query<{ id: string }, []>("SELECT id FROM task").get()!.id;
    });
    const events = seedRecordedActivity(directory, [
      { id: "abcdef12-1234-7000-8000-000000000001", entity_id: taskId, created_at: 3, changes: { title: ["Old title", "Current task"], future: { text: "Full\nrecorded payload" } } },
      { id: "fedcba12-1234-7000-8000-000000000001", entity_id: taskId, created_at: 1, action: "order" },
      { id: "abcdef12-1234-7000-8000-000000000002", entity_id: taskId, created_at: 3, action: "archive", actor_email: null },
      { id: "abcdef12-1234-7000-8000-000000000003", entity_id: taskId, entity_type: "label", created_at: 4 },
    ]);
    const viewed = runZinn(["task", "view", "APP-1", "--history", "--json"], directory);
    expect(viewed.code).toBe(0);
    expect(JSON.parse(viewed.stdout).activity).toEqual([events[2], events[0], events[1]]);
    const previews = runZinn(["activity", "list", "--task", "APP-1"], directory);
    const text = runZinn(["task", "view", "APP-1", "--history"], directory);
    expect(text.code).toBe(0);
    expect(text.stdout.endsWith(previews.stdout)).toBe(true);
    expect(text.stdout).toContain("Old title");
  });
});

test("task view history keeps archived tasks separate from deleted lifetimes with a reused key", () => {
  withIsolatedZinnDir((directory) => {
    const run = (...args: Array<string>) => {
      const result = runZinn(args, directory);
      expect(result.code).toBe(0);
      return result.stdout;
    };
    run("project", "create", "APP");
    run("task", "create", "APP", "--title", "Previous lifetime");
    run("project", "delete", "APP", "--yes");
    run("project", "create", "APP");
    run("task", "create", "APP", "--title", "Current lifetime");
    run("task", "archive", "APP-1");
    const currentTaskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task").get()!.id);
    const allLifetimes: Array<Activity> = JSON.parse(run("activity", "list", "--task", "APP-1", "--json"));
    expect(allLifetimes.some((event) => event.entity_id !== currentTaskId)).toBe(true);
    const viewed = JSON.parse(run("task", "view", "APP-1", "--history", "--json"));
    expect(viewed.status).toBe("Archived");
    expect(viewed.activity).toEqual(allLifetimes.filter((event) => event.entity_type === "task" && event.entity_id === currentTaskId));
    const text = run("task", "view", "APP-1", "--history");
    expect(text).toContain(currentTaskId);
    expect(text).not.toContain("Previous lifetime");
  });
});

function seedRecordedActivity(
  directory: string,
  inputs: Array<Pick<Activity, "id"> & Partial<Activity>>,
) {
  expect(runZinn(["activity", "list", "--json"], directory).code).toBe(0);
  const events: Array<Activity> = inputs.map((input) => ({
    id: input.id,
    created_at: input.created_at ?? Date.UTC(2026, 9, 8, 10, 30),
    actor_name: input.actor_name ?? "Test Agent",
    actor_email: input.actor_email === undefined ? "agent@example.com" : input.actor_email,
    actor_kind: input.actor_kind ?? "agent",
    entity_type: input.entity_type ?? "task",
    entity_id: input.entity_id ?? "11111111-1234-7000-8000-123456abcdef",
    action: input.action ?? "edit",
    changes: input.changes ?? null,
  }));
  withTestDb(directory, (db) => {
    const insert = db.query("INSERT INTO activity (id, created_at, actor_name, actor_email, actor_kind, entity_type, entity_id, action, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const event of events) {
      insert.run(event.id, event.created_at, event.actor_name, event.actor_email, event.actor_kind,
        event.entity_type, event.entity_id, event.action,
        event.changes === null ? null : JSON.stringify(event.changes));
    }
  });
  return events;
}

test("activity empty lists and unrecoverable task histories return empty results", () => {
  withIsolatedZinnDir((directory) => {
    for (const args of [["activity", "list"], ["activity", "list", "--task", "gone-2"]]) {
      const text = runZinn(args, directory);
      expect(text).toEqual({ code: 0, stdout: "", stderr: "" });
      const json = runZinn([...args, "--json"], directory);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([]);
    }
  });
});

test("activity JSON preserves full matching records, parsed payloads and deterministic ordering", () => {
  withIsolatedZinnDir((directory) => {
    const events = seedRecordedActivity(directory, [
      { id: "11111111-1234-7000-8000-123456abcde1", created_at: 1, entity_type: "project", action: "create", changes: { key: "OLD", name: "Old project", columns: [] } },
      { id: "11111111-1234-7000-8000-123456abcde2", created_at: 2, entity_type: "column", action: "order" },
      { id: "11111111-1234-7000-8000-123456abcde3", created_at: 2, entity_type: "label", action: "delete", actor_email: null, changes: { name: "Old label", description: "Full\ntext", future: { values: [1, null] } } },
    ]);
    const listed = runZinn(["activity", "list", "--json"], directory);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([events[2], events[1], events[0]]);
    expect(JSON.parse(runZinn(["activity", "list", "--limit", "1", "--json"], directory).stdout)).toEqual([events[2]]);
    expect(JSON.parse(runZinn(["activity", "list", "--limit", String(Number.MAX_SAFE_INTEGER), "--json"], directory).stdout)).toHaveLength(3);
    for (const event of events) {
      const viewed = runZinn(["activity", "view", event.id, "--json"], directory);
      expect(viewed.code).toBe(0);
      expect(JSON.parse(viewed.stdout)).toEqual(event);
    }
    const text = runZinn(["activity", "list"], directory).stdout;
    expect(text).toContain("order");
    expect(text).toContain("column");
    expect(text).toContain("Entity ID: 11111111-1234-7000-8000-123456abcdef");
    expect(text).toContain("project OLD [recorded]");
    expect(text).toContain("label Old label [recorded]");
  });
});

test("activity returns all events by default and limits only after selecting matches", () => {
  withIsolatedZinnDir((directory) => {
    const events = seedRecordedActivity(directory, Array.from({ length: 55 }, (_, index) => ({
      id: `11111111-1234-7000-8000-${String(index).padStart(12, "0")}`,
      created_at: index,
    })));
    expect(JSON.parse(runZinn(["activity", "list", "--json"], directory).stdout)).toEqual(events.toReversed());
    expect(JSON.parse(runZinn(["activity", "list", "--limit", "2", "--json"], directory).stdout)).toEqual(events.toReversed().slice(0, 2));
  });
});

test("activity task-filtered prefixes remain globally unique even outside the filter and limit", () => {
  withIsolatedZinnDir((directory) => {
    expect(runZinn(["project", "create", "APP"], directory).code).toBe(0);
    expect(runZinn(["task", "create", "APP", "--title", "Current task"], directory).code).toBe(0);
    const taskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task").get()!.id);
    const first = "abcdef12-1234-7000-8000-000000000001";
    const second = "abcdef12-1234-7000-8000-000000000002";
    seedRecordedActivity(directory, [
      { id: first, created_at: Date.now() + 1000, entity_id: taskId },
      { id: second, created_at: Date.now() + 2000, entity_type: "label" },
    ]);
    const filtered = runZinn(["activity", "list", "--task", "app-1", "--limit", "1"], directory);
    expect(filtered.code).toBe(0);
    expect(filtered.stdout.split(" | ")[0]).toBe(first);
    expect(filtered.stdout).toContain("APP-1 · edited");
    expect(filtered.stdout).not.toContain("[current]");
    expect(filtered.stdout).not.toContain(second);
    const ambiguous = runZinn(["activity", "view", "abcdef12", "--json"], directory);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stdout).toBe("");
    const message = JSON.parse(ambiguous.stderr).error.message;
    expect(message).toContain("ambiguous");
    expect(message).toContain(first);
    expect(message).toContain(second);
    expect(message).toContain("more characters");
  });
});

test("activity view accepts normalized IDs and reports malformed, short and missing IDs distinctly", () => {
  withIsolatedZinnDir((directory) => {
    const id = "abcdef12-1234-7000-8000-123456abcdef";
    const [event] = seedRecordedActivity(directory, [{ id }]);
    for (const input of [id, id.toUpperCase(), id.replaceAll("-", ""), "ABCDEF12", "ABCDEF12-1", "ABCDEF121"]) {
      const result = runZinn(["activity", "view", input, "--json"], directory);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(event);
    }
    for (const [input, message] of [
      ["abcdef1", "at least 8"], ["abcd-ef12", "Invalid activity ID"], ["ffffffff", "No activity matches"],
    ] as const) {
      const result = runZinn(["activity", "view", input], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message!);
    }
  });
});

test("activity rejects unsupported, repeated and malformed command arguments without writes", () => {
  withIsolatedZinnDir((directory) => {
    const [event] = seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-123456abcdef" }]);
    const before = withTestDb(directory, (db) => db.query("SELECT * FROM activity").all());
    const invalid = [
      ["list", "APP-1"], ["list", "--project", "APP"],
      ["list", "--task", "APP-1", "--task", "APP-2"],
      ["list", "--limit", "1", "--limit", "2"], ["list", "--task", "APP-0"],
      ["view"], ["view", event!.id, "extra"], ["view", event!.id, "--task", "APP-1"],
    ];
    for (const args of invalid) {
      const result = runZinn(["activity", ...args, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.message.length).toBeGreaterThan(0);
    }
    for (const limit of ["0", "-1", "1.5", "1e2", "01", " 2", "Infinity", "9007199254740992", "99999999999999999"]) {
      const result = runZinn(["activity", "list", `--limit=${limit}`, "--json"], directory);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).error.message).toBe("Activity limit must be a positive safe integer");
    }
    expect(withTestDb(directory, (db) => db.query("SELECT * FROM activity").all())).toEqual(before);
  });
});

test("activity recovers deleted and reused task lifetimes, retaining the original project deletion", () => {
  withIsolatedZinnDir((directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect(run("project", "create", "APP").code).toBe(0);
    expect(run("task", "create", "APP", "--title", "Old lifetime").code).toBe(0);
    expect(run("task", "create", "APP", "--title", "Unrelated").code).toBe(0);
    const oldTaskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task WHERE number = 1").get()!.id);
    expect(run("task", "archive", "APP-1").code).toBe(0);
    const archivedEvents: Array<Activity> = JSON.parse(run("activity", "list", "--task", "APP-1", "--json").stdout);
    const archiveEvent = archivedEvents.find((event) => event.action === "archive")!;
    expect(run("activity", "list", "--task", "APP-1").stdout).not.toContain("[archived]");
    expect(run("activity", "view", archiveEvent.id).stdout).toContain("[archived]");
    expect(run("project", "delete", "APP", "--yes").code).toBe(0);
    const deletion = JSON.parse(run("activity", "list", "--json").stdout).find((event: Activity) => event.entity_type === "project" && event.action === "delete");
    expect(run("project", "create", "APP").code).toBe(0);
    expect(run("task", "create", "APP", "--title", "New lifetime").code).toBe(0);
    const newTaskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task WHERE number = 1").get()!.id);
    const events: Array<Activity> = JSON.parse(run("activity", "list", "--task", "app-1", "--json").stdout);
    expect(events).toHaveLength(4);
    expect(events.find((event) => event.id === deletion.id)).toEqual(deletion);
    expect(new Set(events.filter((event) => event.entity_type === "task").map((event) => event.entity_id))).toEqual(new Set([oldTaskId, newTaskId]));
    const text = run("activity", "list", "--task", "APP-1").stdout;
    expect(text).toContain(`Task identity: current; ${newTaskId}`);
    expect(text).toContain(`Task identity: deleted; ${oldTaskId}`);
    expect(text).toContain(`removed APP-1 (${oldTaskId})`);
    const limited = run("activity", "list", "--task", "APP-1", "--limit", "1").stdout;
    expect(limited).toContain(`Task identity: current; ${newTaskId}`);
    expect(limited).not.toContain(oldTaskId);
    expect(JSON.parse(run("activity", "list", "--task", "APP-99", "--json").stdout)).toEqual([]);
    expect(run("activity", "view", deletion.id).stdout).toContain(oldTaskId);
  });
});

test("activity finds explicit task deletions and deletion-only historical snapshots", () => {
  withIsolatedZinnDir((directory) => {
    expect(runZinn(["project", "create", "APP"], directory).code).toBe(0);
    expect(runZinn(["task", "create", "APP", "--title", "Delete me"], directory).code).toBe(0);
    expect(runZinn(["task", "delete", "APP-1", "--yes"], directory).code).toBe(0);
    const explicit = runZinn(["activity", "list", "--task", "APP-1"], directory);
    expect(explicit.code).toBe(0);
    expect(explicit.stdout).toContain("APP-1 · deleted");
    expect(explicit.stdout).toContain("Delete me");
    const [snapshot] = seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-123456abcdef", entity_type: "project", action: "delete",
      changes: { key: "GONE", tasks: [{ id: "old-task", key: "GONE-2", title: "Snapshot only" }] } }]);
    expect(JSON.parse(runZinn(["activity", "list", "--task", "gone-2", "--json"], directory).stdout)).toEqual([snapshot]);
    expect(runZinn(["activity", "list", "--task", "GONE-2"], directory).stdout).toContain("removed GONE-2 (old-task)");
  });
});

test("activity retains each relation event and uses current names only for navigation", () => {
  withIsolatedZinnDir((directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect(run("project", "create", "APP").code).toBe(0);
    expect(run("task", "create", "APP", "--title", "First").code).toBe(0);
    expect(run("task", "create", "APP", "--title", "Second").code).toBe(0);
    expect(run("task", "relation", "create", "APP-1", "APP-2", "--type", "related").code).toBe(0);
    expect(run("label", "create", "Before").code).toBe(0);
    expect(run("label", "edit", "Before", "--name", "Now").code).toBe(0);
    const events: Array<Activity> = JSON.parse(run("activity", "list", "--json").stdout);
    const relations = events.filter((event) => event.action === "relation_create");
    expect(relations).toHaveLength(2);
    expect(relations[0]!.id).not.toBe(relations[1]!.id);
    expect(relations[0]!.changes).toEqual(relations[1]!.changes);
    const text = run("activity", "list").stdout;
    expect(text.match(/added relation/g)).toHaveLength(2);
    expect(text).toContain("source: APP-1");
    expect(text).toContain("target: APP-2");
    const labelCreate = events.find((event) => event.entity_type === "label" && event.action === "create")!;
    const view = run("activity", "view", labelCreate.id).stdout;
    expect(view).toContain("label Now [current]");
    expect(view).toContain("name:\nBefore");
    expect(JSON.parse(run("activity", "view", labelCreate.id, "--json").stdout)).toEqual(labelCreate);
  });
});

test("activity views preserve recorded text, actor/entity identity, unknown fields and local offsets", () => {
  withIsolatedZinnDir((directory) => {
    const oldText = "  Before\n\tSecond line\n";
    const newText = "  After\r\n\tFinal line  ";
    const id = "abcdef12-1234-7000-8000-123456abcdef";
    const [event] = seedRecordedActivity(directory, [{ id,
      changes: { title: ["Old title", "New title"], description: [oldText, newText], future: { text: "Unknown\ntext", values: [null, 2] } } }]);
    const view = runZinn(["activity", "view", "abcdef12"], directory, { TZ: "Europe/Berlin" });
    expect(view.code).toBe(0);
    expect(view.stdout).toContain(id);
    expect(view.stdout).toContain(event!.entity_id);
    expect(view.stdout).toContain("Test Agent");
    expect(view.stdout).toContain("agent@example.com");
    expect(view.stdout).toContain("Kind: agent");
    expect(view.stdout).toContain("2026-10-08 12:30 +02:00");
    expect(view.stdout).toContain(oldText);
    expect(view.stdout).toContain(newText);
    expect(view.stdout).toContain("Raw JSON:");
    expect(view.stdout).toContain('"future"');
    expect(view.stdout).toContain('"Unknown\\ntext"');
    const listed = runZinn(["activity", "list"], directory).stdout;
    expect(listed).toContain("description changed");
    expect(listed).not.toContain(oldText);
    expect(JSON.parse(runZinn(["activity", "view", id, "--json"], directory).stdout)).toEqual(event);
    const [commentEvent] = seedRecordedActivity(directory, [{ id: "fedcba98-1234-7000-8000-123456abcdef", action: "comment_create",
      changes: { comment: { id: "old-comment", key: "APP-1#1", text: oldText } } }]);
    expect(runZinn(["activity", "view", commentEvent!.id], directory).stdout).toContain(oldText);
  });
});

test.each([0, 9])("activity commands read schema version %i under the existing policy without writes", (version) => {
  withIsolatedZinnDir((directory) => {
    const [event] = seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-123456abcdef", action: "delete",
      changes: { key: "GONE-1", title: "Deleted" } }]);
    withTestDb(directory, (db) => db.run(`PRAGMA user_version = ${version}`));
    const snapshot = () => withTestDb(directory, (db) => ({
      schema: db.query("SELECT * FROM sqlite_schema ORDER BY name").all(),
      events: db.query("SELECT * FROM activity").all(),
      version: db.query("PRAGMA user_version").get(),
    }));
    const before = snapshot();
    if (version === 0) {
      const refused = runZinn(["activity", "list", "--json"], directory);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(JSON.parse(refused.stderr).error.message).toContain("--allow-legacy-read");
    }
    const flags = version === 0 ? ["--allow-legacy-read"] : [];
    for (const args of [["list"], ["list", "--task", "GONE-1"], ["view", event!.id]]) {
      for (const mode of [[], ["--json"]]) {
        const result = runZinn(["activity", ...args, ...flags, ...mode], directory);
        expect(result.code).toBe(0);
        if (version === 0) {
          expect(result.stderr.match(/Warning:/g)).toHaveLength(1);
        } else {
          expect(result.stderr).toBe("");
        }
      }
    }
    expect(snapshot()).toEqual(before);
  });
});
