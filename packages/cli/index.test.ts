import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

import packageJson from "./package.json";
import { runCliInTerminal } from "./testing";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir, withTestDb } from "./test-helpers";
import { parseRoutes } from "./src/routes/router";
import { routes } from "./src/routes/routes";
import { errorDocumentSchema } from "./src/errors";
import type { Activity } from "@zinn-dev/core";
import { latestVersion, MIGRATIONS } from "../core/src/migrations/registry";
import { taskPrioritySchema } from "../core/src/schemas/task";
import { MAX_TEXT_BYTES, relationTypeSchema } from "@zinn-dev/core";

// ? End-to-end tests: each case spawns the real bin, so `ZINN_DIR` is passed
// ? per-spawn rather than set on `process.env`. The route table is imported only
// ? to list the commands; nothing in this process opens a database.

const CURRENT_SCHEMA_VERSION = latestVersion(MIGRATIONS);
const GRAY_BACKLOG = "\x1b[90mBacklog\x1b[39m";
const GREEN_DONE = "\x1b[32mDone\x1b[39m";
// ? Chrome (separators, empty markers, timestamps) is dimmed, never colored: SGR 2 on, SGR 22 off.
const DIM_SEPARATOR = "\x1b[2m | \x1b[22m";
const DIM_EMPTY_PRIORITY = "\x1b[2m-\x1b[22m";
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const SECTION_RULE = "-".repeat(60);
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;

function taskViewContent(output: string) {
  const footerStart = output.lastIndexOf("\n\n");
  const footer = Bun.stripANSI(output.slice(footerStart)).trim();
  expect(footer.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}/g)).toHaveLength(2);
  return `${output.slice(0, footerStart)}\n`;
}

test("names and titles share trimming and reject leading or trailing control characters", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const commands = [
      { args: ["project", "create", "TEXT", "--name"], field: "name" },
      { args: ["project", "column", "create", "TEXT"], field: "name" },
      { args: ["label", "create"], field: "name" },
      { args: ["task", "create", "TEXT", "--title"], field: "title" },
    ];
    for (const { args, field } of commands) {
      const created = await runZinn([...args, " Café 🌿  next ", "--json"], directory);
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
      const edited = await runZinn([...args, " Renamed ", "--json"], directory);
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
        const invalid = await runZinn([...args, value, "--json"], directory);
        expect(invalid.code).toBe(1);
        expect(errorDocumentSchema.parse(JSON.parse(invalid.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: [args.includes("--title") ? "title" : "name"] } });
      }
    }
  });
});

// ? Pipes "y" into the CLI, as a script would; it does not answer a confirmation.
function runZinnWithPipedYes(args: Array<string>, testDir: string) {
  return runProcessAsync(
    ["/bin/sh", "-c", 'printf "y\\n" | exec bun "$@"', "zinn-confirm", CLI_PATH, ...args],
    { env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir }, cwd: testDir },
  );
}

// ? Runs the CLI in a pseudo-terminal, so stdout is a TTY and text output is colored.
function runZinnInTerminal(
  args: Array<string>,
  testDir: string,
  additionalEnv: Record<string, string> = {},
  columns?: number,
) {
  return runCliInTerminal(args, { env: { ...TEST_ENVIRONMENT, ...additionalEnv, ZINN_DIR: testDir }, cwd: testDir, columns });
}

// --- ENTRYPOINT

test("bare invocation shows root help and exits zero", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn([], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result).toEqual(await runZinn(["--help"], testDir));
  });
});

test("--version and -v print the CLI package version and exit zero", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const longVersion = await runZinn(["--version"], testDir);
    const shortVersion = await runZinn(["-v"], testDir);

    expect(longVersion.code).toBe(0);
    expect(longVersion.stdout).toBe(`${packageJson.version}\n`);
    expect(longVersion.stderr).toBe("");
    expect(shortVersion).toEqual(longVersion);
  });
});

test("root help supports -h and --help and lists commands", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const longHelp = await runZinn(["--help"], testDir);
    const shortHelp = await runZinn(["-h"], testDir);

    expect(longHelp.code).toBe(0);
    expect(longHelp.stdout).toContain("Usage: zinn <command>");
    expect(longHelp.stdout).toContain(`project column {${Object.keys(routes.project.column).join("|")}}`);
    expect(longHelp.stdout).toContain("project {create|list|view|edit|delete}");
    expect(longHelp.stdout).toContain("task {create|list|search|view|edit|move|order|archive|unarchive|delete}");
    expect(longHelp.stdout).toContain("task comment {create|list|view|edit|delete}");
    for (const command of Object.keys(routes)) {
      expect(longHelp.stdout).toContain(command);
    }
    expect(longHelp.stdout).toContain("-v");
    expect(longHelp.stdout).toContain("--version");
    expect(shortHelp).toEqual(longHelp);
  });
});

// --- ROUTING

test("an unrecognized command exits nonzero", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["--json", "task", "destroy", "WIP"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "command" } });
  });
});

test("a nested route resolves past its namespace", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "NEST", "--name", "Nested"], testDir);

    // ? `project column list` is three tokens deep; proves the router peels the
    // ? namespace prefix and forwards only "NEST" as the command args.
    const result = await runZinn(["project", "column", "list", "NEST"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Backlog");
  });
});

test("ZINN-299: ZINN_DEBUG=1 prints routing detail on stderr and leaves stdout unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "DBG", "--name", "Debug"], dir);
    const plain = await runZinn(["project", "list", "--json"], dir);

    const debugged = await runZinn(["project", "list", "--json"], dir, { ZINN_DEBUG: "1" });
    expect(debugged.code).toBe(0);
    expect(debugged.stdout).toBe(plain.stdout);
    expect(debugged.stderr).toContain("project list");

    const ignoredEnvironments: Array<Record<string, string>> = [{ DEBUG: "1" }, { ZINN_DEBUG: "true" }];
    for (const env of ignoredEnvironments) {
      const ignored = await runZinn(["project", "list", "--json"], dir, env);
      expect(ignored.stdout).toBe(plain.stdout);
      expect(ignored.stderr).toBe("");
    }
  });
});

test("namespace help describes every descendant command in route order without running one", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const parsedRoutes = parseRoutes(routes);
    for (const namespace of routeNamespaces) {
      const result = await runZinn([...namespace.split(" "), "--help"], testDir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: zinn ${namespace} <command>`);

      const commandLines = result.stdout.split("\n").filter((line) => line.startsWith("  "));
      const namespaceRoutes = parsedRoutes.filter(({ command }) => command.startsWith(`${namespace} `));
      expect(commandLines).toHaveLength(namespaceRoutes.length);
      namespaceRoutes.forEach(({ command, summary }, index) => {
        const relativeCommand = command.slice(namespace.length + 1);
        const line = commandLines[index]!.trimStart();
        expect(line.startsWith(`${relativeCommand}  `)).toBe(true);
        expect(line.slice(relativeCommand.length).trimStart()).toBe(summary);
      });
    }
    expect(existsSync(join(testDir, "data"))).toBe(false);
  });
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

test("every command help exits cleanly instead of running the command", async () => {
  await withIsolatedZinnDir(async (dir) => {
    // ? ZINN-67: arguments before and after the flag do not change which help prints.
    const argumentsAroundFlag = [
      { before: [], after: [] },
      { before: ["APP-1"], after: ["APP-2", "--json"] },
    ];

    for (const command of routeCommands) {
      for (const flag of HELP_FLAGS) {
        for (const { before, after } of argumentsAroundFlag) {
          const result = await runZinn([...command.split(" "), ...before, flag, ...after], dir);
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout).toContain(`Usage: zinn ${command}`);
        }
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 30_000);

test("every namespace help exits cleanly instead of running a command", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const namespace of routeNamespaces) {
      for (const flag of HELP_FLAGS) {
        // ? ZINN-67: words after the flag are not read, even a known command or a typo.
        for (const after of [[], ["view", "APP-1"], ["shwo"]]) {
          const result = await runZinn([...namespace.split(" "), flag, ...after], dir);
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout).toContain(`Usage: zinn ${namespace} <command>`);
        }
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

test("a bare namespace is an error that carries the namespace help", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const namespace of routeNamespaces) {
      const help = await runZinn([...namespace.split(" "), "--help"], dir);
      const text = await runZinn(namespace.split(" "), dir);
      expect(text.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain(`Usage: zinn ${namespace} <command>`);
      expect(text.stderr).toContain(help.stdout.trimEnd());

      const json = await runZinn([...namespace.split(" "), "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      const { error } = JSON.parse(json.stderr);
      expect(typeof error.message).toBe("string");
      expect(error.help).toContain(`Usage: zinn ${namespace} <command>`);
      expect(error.help).toBe(help.stdout.trimEnd());
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

test("a help flag before command words prints help for the words before it", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const rootHelpRequests = [
      ["--help", "task", "view"],
      ["--json", "--help"],
      ["--allow-legacy-read", "--help"],
    ];
    for (const args of rootHelpRequests) {
      const result = await runZinn(args, dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(ROOT_USAGE);
    }

    // ? Help stays text under --json.
    const jsonCommandHelp = await runZinn(["task", "view", "--json", "--help"], dir);
    expect(jsonCommandHelp.code).toBe(0);
    expect(jsonCommandHelp.stdout).toContain("Usage: zinn task view");
    expect(() => JSON.parse(jsonCommandHelp.stdout)).toThrow();
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

test("an unknown command with a help flag fails with the nearest namespace help on stderr", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const cases = [
      { args: ["task", "shwo", "APP-1", "--help"], namespace: ["task"] },
      { args: ["task", "relation", "shwo", "-h"], namespace: ["task", "relation"] },
      { args: ["bogus", "--help"], namespace: [] },
    ];

    for (const { args, namespace } of cases) {
      const usage = namespace.length === 0
        ? ROOT_USAGE
        : `Usage: zinn ${namespace.join(" ")} <command>`;
      const help = await runZinn([...namespace, "--help"], dir);
      const text = await runZinn(args, dir);
      expect(text.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain(usage);
      expect(text.stderr).toContain(help.stdout.trimEnd());

      const json = await runZinn([...args, "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      const { error } = JSON.parse(json.stderr);
      expect(typeof error.message).toBe("string");
      expect(error.help).toContain(usage);
      expect(error.help).toBe(help.stdout.trimEnd());
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

test("an unknown command without a help flag points to the nearest namespace help", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const cases = [
      { args: ["task", "shwo", "APP-1"], helpCommand: "zinn task --help" },
      { args: ["bogus"], helpCommand: "zinn --help" },
    ];

    for (const { args, helpCommand } of cases) {
      const text = await runZinn(args, dir);
      expect(text.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain(helpCommand);
      expect(text.stderr).not.toContain("Usage:");

      const json = await runZinn([...args, "--json"], dir);
      expect(json.code).toBe(1);
      const { error } = JSON.parse(json.stderr);
      expect(error.message).toContain(helpCommand);
      expect(error).not.toHaveProperty("help");
    }
  });
});

test("a help flag after command arguments saves nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "APP"], dir);
    const columns = () => withTestDb(dir, (db) => db.query("SELECT * FROM project_column ORDER BY id").all());
    const before = columns();

    const result = await runZinn(["project", "column", "create", "APP", "--help"], dir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: zinn project column create");
    expect(columns()).toEqual(before);
  });
});

test("root help and activity namespace help list the activity commands", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["--help"], directory)).stdout).toContain("activity {list|view}");
    const activityHelp = await runZinn(["activity", "--help"], directory);
    for (const { command } of parseRoutes(routes).filter(({ command }) => command.startsWith("activity "))) {
      expect(activityHelp.stdout).toContain(command.slice("activity ".length));
    }
  });
});

// --- ARGUMENTS

test("every command rejects an unknown option before it opens the database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const command of routeCommands) {
      const result = await runZinn([...command.split(" "), "--bogus"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      // ? ZINN-108: a guessed flag is named with the usage line, without advice to put it after --.
      const [message, usage] = result.stderr.split("\n\n");
      expect(message).toContain("--bogus");
      expect(message).not.toContain("-- ");
      expect(usage).toContain(`Usage: zinn ${command}`);
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
  "project column delete": { words: ["SHOP", "TODO"], required: 2 },
  "task create": { words: ["SHOP"], required: 1, repeatableFlags: ["label", "depends-on", "related"] },
  "task list": { words: ["SHOP"], required: 0, repeatableFlags: ["label"] },
  "task search": { words: ["refine", "SHOP"], required: 1, repeatableFlags: ["label"] },
  "task view": { words: ["SHOP-1"], required: 1 },
  "task edit": { words: ["SHOP-1"], required: 1, repeatableFlags: ["add-label", "remove-label"] },
  "task move": { words: ["SHOP-1", "Done"], required: 2, repeats: true },
  "task order": { words: ["SHOP-1", "top"], required: 2 },
  "task archive": { words: ["SHOP-1"], required: 1, repeats: true },
  "task unarchive": { words: ["SHOP-1"], required: 1, repeats: true },
  "task delete": { words: ["SHOP-1"], required: 1, repeats: true },
  "task relation create": { words: ["SHOP-1", "SHOP-2"], required: 2 },
  "task relation list": { words: ["SHOP-1"], required: 1 },
  "task relation delete": { words: ["SHOP-1", "SHOP-2"], required: 2 },
  "task comment create": { words: ["SHOP-1"], required: 1 },
  "task comment list": { words: ["SHOP-1"], required: 1 },
  "task comment view": { words: ["SHOP-1#1"], required: 1 },
  "task comment edit": { words: ["SHOP-1#1"], required: 1 },
  "task comment delete": { words: ["SHOP-1#1"], required: 1 },
  "task label add": { words: ["SHOP-1", "bug"], required: 2, repeats: true },
  "task label remove": { words: ["SHOP-1", "bug"], required: 2, repeats: true },
  "label create": { words: ["bug"], required: 1 },
  "label list": { words: [], required: 0 },
  "label view": { words: ["bug"], required: 1 },
  "label edit": { words: ["bug"], required: 1 },
  "label delete": { words: ["bug"], required: 1 },
  "activity list": { words: [], required: 0, repeatableFlags: ["action", "changed"] },
  "activity view": { words: ["019abcdf"], required: 1 },
  info: { words: [], required: 0 },
  whoami: { words: [], required: 0 },
  capabilities: { words: [], required: 0 },
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

test("every command rejects an extra word, naming it with the usage line, before it opens the database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words, repeats }] of Object.entries(commandWords)) {
      if (repeats) {
        continue;
      }

      const result = await runZinn([...command.split(" "), ...words, EXTRA_WORD], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(EXTRA_WORD);
      expect(result.stderr).toContain(`Usage: zinn ${command}`);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("every command with required words rejects one word too few, naming a word its usage line writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words, required }] of Object.entries(commandWords)) {
      if (required === 0) {
        continue;
      }

      const result = await runZinn([...command.split(" "), ...words.slice(0, required - 1)], dir);
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

test("every flag in a usage line is rejected when given twice, unless the command repeats it", async () => {
  await withIsolatedZinnDir(async (dir) => {
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
        const result = await runZinn([...command.split(" "), ...words, ...flag, ...flag], dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`--${name}`);
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("every flag followed by <value> in a usage line refuses a separate value that begins with a dash, showing it joined with =", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words }] of Object.entries(commandWords)) {
      const valueFlags = [...commandUsages.get(command)!.matchAll(/(--[a-z-]+) </g)].map(([, flag]) => flag!);
      for (const flag of valueFlags) {
        const result = await runZinn([...command.split(" "), ...words, flag, "- item"], dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`${flag}='- item'`);
        expect(result.stderr).toContain(`Usage: zinn ${command}`);
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("every command refuses a word that begins with a single dash, showing the command with it after --", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words }] of Object.entries(commandWords)) {
      const result = await runZinn([...command.split(" "), ...words, "-later"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`zinn ${command} `);
      expect(result.stderr).toContain(" -- -later");
      expect(result.stderr).toContain(`Usage: zinn ${command}`);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("the command shown for a word that begins with a single dash runs as shown, keeping --json before --", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    const refused = await runZinn(["project", "column", "create", "SHOP", "-later", "--json"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");

    const { error } = JSON.parse(refused.stderr);
    expect(error.help).toContain("Usage: zinn project column create");
    const shownArgs = error.message.match(/zinn (.*)$/)[1];
    const proc = await runProcessAsync(["/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir,
    });
    expect(proc.code).toBe(0);
    expect(JSON.parse(proc.stdout)).toMatchObject({ name: "-later" });
  });
});

const relationSuggestionCommands = parseRoutes(routes).filter(
  ({ command, guessedFlags }) => command.startsWith("task relation ") && guessedFlags !== undefined,
);
const expectedRelationTypes: Record<string, string> = {
  "--depends-on": "dependency",
  "--parent": "subtask",
  "--duplicate-of": "duplicate",
  "--related": "related",
};

for (const command of relationSuggestionCommands) {
  test(`${command.command} corrects borrowed relation flags with runnable commands and preserves direction`, async () => {
    await withIsolatedZinnDir(async (dir) => {
      expect((await runZinn(["project", "create", "LINK"], dir)).code).toBe(0);
      const source = await runZinn(["task", "create", "LINK", "--title", "Source", "--json"], dir);
      const target = await runZinn(["task", "create", "LINK", "--title", "Target", "--json"], dir);
      expect(source.code).toBe(0);
      expect(target.code).toBe(0);
      const sourceId = JSON.parse(source.stdout).id;
      const targetId = JSON.parse(target.stdout).id;
      const words = command.command.split(" ");
      const isCreating = command.effects.domain !== "delete";
      const flags = Object.keys(command.guessedFlags ?? {});
      expect(new Set(flags.map((flag) => expectedRelationTypes[flag]))).toEqual(new Set(relationTypeSchema.options));
      const snapshot = () => withTestDb(dir, (db) => ({
        tasks: db.query("SELECT * FROM task ORDER BY id").all(),
        relations: db.query("SELECT * FROM task_relations ORDER BY id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));

      for (const flag of flags) {
        const type = expectedRelationTypes[flag]!;
        for (const flagArgs of [[flag, "LINK-2"], [`${flag}=LINK-2`]]) {
          for (const matchingType of [false, true]) {
            if (!isCreating) {
              expect((await runZinn(["task", "relation", "create", "LINK-1", "LINK-2", "--type", type], dir)).code).toBe(0);
            }
            const args = matchingType
              ? [...flagArgs, `--type=${type}`, "--", "LINK-1"]
              : ["LINK-1", ...flagArgs];
            const before = snapshot();
            const refused = await runZinn([...words, "--json", ...args], dir);
            expect(refused.code).toBe(1);
            expect(refused.stdout).toBe("");
            expect(snapshot()).toEqual(before);
            const { error } = errorDocumentSchema.parse(JSON.parse(refused.stderr));
            expect(error.details).toMatchObject({ argument: flag });
            const shownArgs = error.message.match(/zinn ([\s\S]*)$/)![1]!;
            const corrected = await runProcessAsync([
              "/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH,
            ], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir });
            expect(corrected.code).toBe(0);
            expect(corrected.stderr).toBe("");
            expect(JSON.parse(corrected.stdout)).toMatchObject({
              type, source: "LINK-1", target: "LINK-2", source_task_id: sourceId, target_task_id: targetId,
            });
            const after = snapshot();
            if (isCreating) {
              expect(after.relations).toEqual([expect.objectContaining({
                source_task_id: sourceId, target_task_id: targetId, relation_type: type,
              })]);
              expect((await runZinn(["task", "relation", "delete", "LINK-1", "LINK-2", "--type", type], dir)).code).toBe(0);
            } else {
              expect(after.relations).toEqual([]);
            }
          }
        }
      }
    });
  });

  test(`${command.command} leaves ambiguous or incomplete relation flags without a suggestion`, async () => {
    await withIsolatedZinnDir(async (dir) => {
      const words = command.command.split(" ");
      const cases = [
        ["LINK-1", "--parent", "LINK-2", "--related", "LINK-3"],
        ["LINK-1", "--parent", "LINK-2", "--parent=LINK-3"],
        ["LINK-1", "LINK-3", "--parent=LINK-2"],
        ["LINK-1", "--parent=LINK-2", "--type", "dependency"],
        ["--parent", "LINK-2"],
        ["LINK-1", "--parent"],
        ["LINK-1", "--parent=LINK-2", "--type"],
        ["LINK-1", "--parent=LINK-2", "--type=subtask", "--type=subtask"],
        ["LINK-1", "--parent=LINK-2", "--unknown"],
        ["LINK-1", "--type=dependency", "--parent=LINK-2", "--type=subtask"],
      ];
      for (const args of cases) {
        const refused = await runZinn([...words, ...args, "--json"], dir);
        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe("");
        const { error } = errorDocumentSchema.parse(JSON.parse(refused.stderr));
        expect(error.code).toBe("invalid_input");
        expect(error.message).not.toContain("zinn task relation");
        expect(readdirSync(dir)).toEqual([]);
      }
      const help = await runZinn([...words, "--help"], dir);
      expect(help.code).toBe(0);
      expect(help.stdout.split("\n")[0]).toContain(`--type {${relationTypeSchema.options.join("|")}}`);
    });
  });
}

for (const command of [
  ["task", "create"],
  ["task", "edit"],
  ["task", "comment", "create"],
  ["task", "comment", "edit"],
]) {
  test(`${command.join(" ")} corrects --body with a runnable command that preserves text and modifiers`, async () => {
    await withIsolatedZinnDir(async (dir) => {
      expect((await runZinn(["project", "create", "SHOP"], dir)).code).toBe(0);
      const isComment = command.includes("comment");
      const isEdit = command.at(-1) === "edit";
      const initialText = "Keep --body twice: --body";
      const body = "It's literal: $(false) `false`\n--body=keep";
      const title = "Keep the other task fields";
      const modes = [
        { args: [], expected: body },
        ...(isEdit ? [
          { args: ["--append"], expected: `${initialText}\n\n${body}` },
          { args: ["--replacing=--body", "--all"], expected: initialText.replaceAll("--body", body) },
        ] : []),
      ];
      const snapshot = () => withTestDb(dir, (db) => ({
        tasks: db.query("SELECT * FROM task ORDER BY id").all(),
        comments: db.query("SELECT * FROM comment ORDER BY id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));

      for (const mode of modes) {
        for (const bodyArgs of [["--body", body], [`--body=${body}`]]) {
          const seed = await runZinn([
            "task", "create", "SHOP", "--title", "Seed task", "--description", initialText, "--json",
          ], dir);
          expect(seed.code).toBe(0);
          const taskKey = JSON.parse(seed.stdout).key;
          let target = isEdit || isComment ? taskKey : "SHOP";
          if (isEdit && isComment) {
            const comment = await runZinn([
              "task", "comment", "create", taskKey, "--text", initialText, "--json",
            ], dir);
            expect(comment.code).toBe(0);
            target = JSON.parse(comment.stdout).key;
          }

          const before = snapshot();
          const otherFlags = isComment ? [] : ["--title", title, "--priority", "high"];
          const refused = await runZinn([
            ...command, target, ...otherFlags, ...bodyArgs, ...mode.args, "--json",
          ], dir);
          expect(refused.code).toBe(1);
          expect(refused.stdout).toBe("");
          expect(snapshot()).toEqual(before);

          const { error } = errorDocumentSchema.parse(JSON.parse(refused.stderr));
          expect(error.details).toMatchObject({ argument: "--body" });
          const shownArgs = error.message.match(/zinn ([\s\S]*)$/)![1]!;
          const corrected = await runProcessAsync([
            "/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH,
          ], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir });
          expect(corrected.code).toBe(0);
          expect(corrected.stderr).toBe("");
          const result = JSON.parse(corrected.stdout);
          const textField = isComment ? "text" : "description";
          expect(result[textField]).toBe(mode.expected);
          if (!isComment) {
            expect(result).toMatchObject({ title, priority: "high" });
          }
          const viewed = await runZinn([
            "task", ...(isComment ? ["comment"] : []), "view", result.key, "--json",
          ], dir);
          expect(viewed.code).toBe(0);
          expect(JSON.parse(viewed.stdout)[textField]).toBe(mode.expected);
        }
      }
    });
  });
}

test("a guessed --status on task create suggests --column and preserves the other creation arguments", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    await runZinn(["label", "create", "bug"], dir);
    await runZinn(["label", "create", "urgent"], dir);
    const title = "Fix it's bug; $(false)";
    const description = "Keep --status=Done as text\nwith a second line";

    const cases = [
      { statusArgs: ["--status", "In Progress"], projectAfterOptions: false },
      { statusArgs: ["--status=In Progress"], projectAfterOptions: false },
      { statusArgs: ["--status", "In Progress"], projectAfterOptions: true },
    ];
    for (const { statusArgs, projectAfterOptions } of cases) {
      const before = (await runZinn(["task", "list", "SHOP", "--json"], dir)).stdout;
      const activityBefore = await runZinn(["activity", "list", "--project", "SHOP", "--json"], dir);
      expect(activityBefore.code).toBe(0);
      const refused = await runZinn([
        "task", "create", ...(projectAfterOptions ? [] : ["SHOP"]), "--title", title, "--description", description,
        ...statusArgs, "--label", "bug", "--label", "urgent", "--priority", "high", "--json",
        ...(projectAfterOptions ? ["--", "SHOP"] : []),
      ], dir);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect((await runZinn(["task", "list", "SHOP", "--json"], dir)).stdout).toBe(before);
      const activityAfter = await runZinn(["activity", "list", "--project", "SHOP", "--json"], dir);
      expect(activityAfter.code).toBe(0);
      expect(activityAfter.stdout).toBe(activityBefore.stdout);

      const { error } = errorDocumentSchema.parse(JSON.parse(refused.stderr));
      expect(error.details).toMatchObject({ argument: "--status" });
      const shownArgs = error.message.match(/zinn (task create [\s\S]*)$/)![1]!;
      const created = await runProcessAsync(["/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH], {
        env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir,
      });
      expect(created.code).toBe(0);
      expect(created.stderr).toBe("");
      expect(JSON.parse(created.stdout)).toMatchObject({
        title, description, column: "In Progress", priority: "high", labels: ["bug", "urgent"],
      });
    }
  });
});

test("a guessed --status or --column on task edit or task move suggests the task move command that runs as shown", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "First"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "Second"], dir);
    const readColumns = () => withTestDb(dir, (db) =>
      db.query<{ column: string }, []>(
        "SELECT project_column.name AS column FROM task JOIN project_column ON project_column.id = task.column_id ORDER BY task.id",
      ).all().map(({ column }) => column),
    );

    const cases: Array<[string[], string[]]> = [
      [["task", "edit", "SHOP-1", "--status", "In Progress"], ["In Progress", "Backlog"]],
      [["task", "edit", "SHOP-1", "--title", "Renamed", "--column=Done"], ["Done", "Backlog"]],
      [["task", "move", "SHOP-1", "SHOP-2", "--column", "TODO"], ["TODO", "TODO"]],
    ];
    for (const [args, columnsAfter] of cases) {
      const before = readColumns();
      const refused = await runZinn([...args, "--json"], dir);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(readColumns()).toEqual(before);

      const { error } = JSON.parse(refused.stderr);
      expect(error.help).toContain(`Usage: zinn ${args.slice(0, 2).join(" ")}`);
      const shownArgs = error.message.match(/zinn (task move .*)$/)[1];
      const proc = await runProcessAsync(["/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH], {
        env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir,
      });
      expect(proc.code).toBe(0);
      expect(() => JSON.parse(proc.stdout)).not.toThrow();
      expect(readColumns()).toEqual(columnsAfter);
    }
  });
});

test("every flag followed by <value> in a usage line fails without its value, showing the usage line", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words }] of Object.entries(commandWords)) {
      const valueFlags = [...commandUsages.get(command)!.matchAll(/(--[a-z-]+) </g)].map(([, flag]) => flag!);
      for (const flag of valueFlags) {
        const result = await runZinn([...command.split(" "), ...words, flag], dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(flag);
        expect(result.stderr).toContain(`Usage: zinn ${command}`);
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("the command shown for a value that begins with a dash runs as shown", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    const refused = await runZinn(["task", "create", "SHOP", "--title", "Fix it's bug", "--description", "- item", "--json"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(JSON.parse((await runZinn(["task", "list", "SHOP", "--json"], dir)).stdout)).toEqual([]);

    const { error } = JSON.parse(refused.stderr);
    expect(error.help).toContain("Usage: zinn task create");
    const shownArgs = error.message.match(/zinn (.*)$/)[1];
    const proc = await runProcessAsync(["/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir,
    });
    expect(proc.code).toBe(0);
    expect(JSON.parse(proc.stdout)).toMatchObject({ title: "Fix it's bug", description: "- item" });
  });
});

test("long parser and routing errors bound both output modes without changing error facts or writing data", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const longText = "x".repeat(1300);
    const cases = [
      { args: ["task", "create", "APP", "--title", "Kept", "--description", `- ${longText}`], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", longText, "--description", "- item"], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", "'".repeat(300), "--description", "- item"], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", "Kept", "--description", "- 😀\n".repeat(400)], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", "Kept", "--description", `- ${"e\u0301".repeat(700)}`], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", "Kept", "--description", `- ${"👨‍👩‍👧‍👦".repeat(200)}`], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "search", `-${longText}`], facts: ["--"], repair: true },
      { args: ["task", "search", `-${longText}`, "--unknown"], facts: ["--"] },
      { args: ["task", "create", "APP", "--title", "Kept", "--body", longText], argument: "--body", facts: ["--body"], repair: true },
      { args: ["project", "list", `--${longText}`], argument: `--${longText}`, facts: ["--"] },
      { args: ["project", "list", longText], field: [], facts: ["…"] },
      { args: ["task", "order", "APP-1", longText], argument: "direction", facts: ["…"] },
      { args: [longText], argument: "command", facts: ["zinn --help"] },
      { args: ["task", longText, "--help"], argument: "command", facts: ["…"] },
    ];
    for (const { args, argument, field, facts, repair } of cases) {
      const text = await runZinn(args, directory);
      const json = await runZinn(["--json", ...args], directory);
      expect(text.code).toBe(1);
      expect(json.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(json.stdout).toBe("");
      const { error } = errorDocumentSchema.parse(JSON.parse(json.stderr));
      expect(error.code).toBe("invalid_input");
      expect(error.message.length).toBeLessThanOrEqual(1024);
      expect(error.message.isWellFormed()).toBe(true);
      expect(text.stderr).toBe(`${error.message}${error.help === undefined ? "" : `\n\n${error.help}`}\n`);
      if (argument !== undefined) {
        expect(error.details?.argument).toBe(argument);
      }
      if (field !== undefined) {
        expect(error.details?.field).toEqual(field);
      }
      for (const fact of facts) {
        expect(error.message).toContain(fact);
      }
      if (repair) {
        expect(error.message).toMatch(/omitt/i);
        expect(error.message).not.toMatch(/zinn (?:task|project)/);
      }
    }
    expect(readdirSync(directory)).toEqual([]);
  });
});

test("oversized column repair commands retain quoting guidance and leave existing data intact", async () => {
  await withIsolatedZinnDir(async (directory) => {
    await runZinn(["project", "create", "APP"], directory);
    const before = await runZinn(["project", "view", "APP", "--json"], directory);
    const activityBefore = await runZinn(["activity", "list", "--json"], directory);
    const args = ["task", "create", "APP", "--title", "x".repeat(1300), "--column", "In", "Progress"];
    for (const flags of [[], ["--json"]]) {
      const refused = await runZinn([...args, ...flags], directory);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      const message = flags.length === 0
        ? refused.stderr.split("\n\n")[0]!
        : errorDocumentSchema.parse(JSON.parse(refused.stderr)).error.message;
      expect(message.length).toBeLessThanOrEqual(1024);
      expect(message).toMatch(/quot/i);
      expect(message).toMatch(/column/i);
      expect(message).toMatch(/omitt/i);
      expect(message).not.toContain("zinn task create");
    }
    expect(await runZinn(["project", "view", "APP", "--json"], directory)).toEqual(before);
    expect(await runZinn(["activity", "list", "--json"], directory)).toEqual(activityBefore);
    expect(JSON.parse((await runZinn(["task", "list", "APP", "--json"], directory)).stdout)).toEqual([]);
  });
});

test("project list, project view, the project column commands, task view and task order reject invalid requests without writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "First"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "Second"], dir);
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
        const result = await runZinn([...command.split(" "), ...args], dir);
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
      const result = await runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`"sideways"`);
      expect(result.stderr).toContain("{before|after}");
      expect(read()).toEqual(before);
    }
  });
}, 30_000);

test("a -- in front of the words or at the end leaves a valid command working", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "First"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "Second"], dir);

    const sameAsWithout: Array<[string[], string[]]> = [
      [["task", "view", "--", "SHOP-1"], ["task", "view", "SHOP-1"]],
      [["project", "view", "SHOP", "--"], ["project", "view", "SHOP"]],
      [["project", "column", "list", "--", "SHOP"], ["project", "column", "list", "SHOP"]],
    ];
    for (const [withSeparator, withoutSeparator] of sameAsWithout) {
      const result = await runZinn(withSeparator, dir);
      expect(result.code).toBe(0);
      expect(result).toEqual(await runZinn(withoutSeparator, dir));
    }

    expect((await runZinn(["task", "order", "SHOP-2", "top", "--"], dir)).code).toBe(0);
    expect((await runZinn(["task", "list", "SHOP"], dir)).stdout).toMatch(/SHOP-2[^\n]*\nSHOP-1/);
  });
});

test("delete commands reject invalid keys and repeated --yes without deleting anything", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "A"], dir);
    await runZinn(["project", "create", "B"], dir);
    await runZinn(["task", "create", "A", "--title", "First"], dir);
    await runZinn(["task", "create", "A", "--title", "Second"], dir);
    await runZinn(["task", "comment", "create", "A-1", "--text", "Note"], dir);
    await runZinn(["label", "create", "bug"], dir);
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
      [["project", "delete", "A", "B", "--yes"], `"B"`, "Usage: zinn project delete"],
      // After --, a flag is a task-key operand and fails key validation.
      [["task", "delete", "--", "A-1", "--yes"], `"--yes"`],
      [["task", "delete", "A-1", "--yes", "--", "--"], `"--"`],
      [["project", "delete", "A", "--yes", "--yes"], "--yes"],
      [["task", "delete", "A-1", "--yes", "--yes"], "--yes"],
      [["task", "comment", "delete", "A-1#1", "--yes", "--yes"], "--yes"],
      [["label", "delete", "bug", "--yes", "--yes"], "--yes"],
    ];
    for (const [args, ...facts] of cases) {
      const result = await runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
      expect(read()).toEqual(before);
    }
  });
});

test("--json or --allow-legacy-read given twice runs nothing, while a second help flag still shows help", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const flag of ["--json", "--allow-legacy-read"]) {
      const result = await runZinn(["project", "create", "APP", flag, flag], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(flag);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);

    const help = await runZinn(["task", "view", "A-1", "-h", "--help"], dir);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: zinn task view");
  });
});

test("with --json, an extra word is one JSON error on stderr whose help is the usage line", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["task", "view", "A-1", "A-2", "--json"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const { error } = JSON.parse(result.stderr);
    expect(error.message).toContain("A-2");
    expect(error.help).toContain("Usage: zinn task view");
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

// --- PROJECT

test("project create seeds the default columns", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "WIP", "--name", "Work"], testDir)).code).toBe(0);

    const listed = await runZinn(["project", "column", "list", "WIP", "--json"], testDir);

    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      { id: expect.any(String), name: "Backlog", taskCount: 0 },
      { id: expect.any(String), name: "TODO", taskCount: 0 },
      { id: expect.any(String), name: "In Progress", taskCount: 0 },
      { id: expect.any(String), name: "Review", taskCount: 0 },
      { id: expect.any(String), name: "Done", taskCount: 0 },
    ]);
  });
});

test("project create requires a key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["project", "create"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: zinn project create");
  });
});

test("project create defaults the stored name to the uppercase key and allows a later rename", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const created = await runZinn(["project", "create", "site"], testDir);

    expect(created.code).toBe(0);
    expect(created.stdout).toBe("SITE | SITE\n");
    withTestDb(testDir, (db) => {
      expect(db.query("SELECT key, name FROM project").get()).toEqual({
        key: "SITE",
        name: "SITE",
      });
    });

    const edited = await runZinn(["project", "edit", "SITE", "--name", "Website refresh"], testDir);
    expect(edited.code).toBe(0);
    expect((await runZinn(["project", "list"], testDir)).stdout).toBe("SITE | Website refresh | 0 active | 0 archived\n");
  });
});

test("project create rejects extra positionals and invalid name flags", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    for (const args of [
      ["SITE", "Website"],
      ["SITE", "--name"],
      ["SITE", "--name", "First", "--name", "Second"],
      ["SITE", "--title", "Website"],
    ]) {
      expect((await runZinn(["project", "create", ...args], testDir)).code).toBe(1);
    }
    expect((await runZinn(["project", "list"], testDir)).stdout).toBe("");
  });
});

test("project create rejects a duplicate key regardless of casing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "DUP", "--name", "First"], testDir)).code).toBe(0);

    const second = await runZinn(["--json", "project", "create", "dup", "--name", "Second"], testDir);

    expect(second.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(second.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "project", key: "DUP" } });
  });
});

test("project delete accepts a non-standardized key and removes its columns and tasks", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "GONE", "--name", "Doomed"], testDir);
    await runZinn(["task", "create", "GONE", "--title", "Doomed task"], testDir);
    await runZinn(["project", "create", "KEEP", "--name", "Kept"], testDir);
    await runZinn(["task", "create", "KEEP", "--title", "Kept task"], testDir);

    expect(
      (await runZinn(["project", "delete", "gone", "--yes"], testDir)).code,
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

test.serial("project delete keeps the project when confirmation is declined", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KEEP", "--name", "Kept"], testDir);
    await runZinn(["task", "create", "KEEP", "--title", "Kept task"], testDir);

    const result = await runCliInTerminal(["project", "delete", "keep"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir, NO_COLOR: "1" },
      cwd: testDir,
      input: "n\n",
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain("KEEP | Kept");
    expect((await runZinn(["project", "list"], testDir)).stdout).toContain("KEEP | Kept");
    expect((await runZinn(["task", "list", "KEEP"], testDir)).stdout).toContain("Kept task");
  });
});

test("project delete rejects an unknown key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["--json", "project", "delete", "NOSUCH"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOSUCH" } });
  });
});

test("project list on an empty database exits cleanly without inventing a row", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("project list renders every project once and aligns unequal key widths", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "a", "--name", "Short"], testDir)).code).toBe(0);
    expect((await runZinn(["project", "create", "LONGKEY", "--name", "Long"], testDir)).code).toBe(0);

    const result = await runZinn(["project", "list"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines).toHaveLength(2);
    const rows = lines.map((line) => line.split("|").map((cell) => cell.trim()));
    expect(rows).toContainEqual(["A", "Short", "0 active", "0 archived"]);
    expect(rows).toContainEqual(["LONGKEY", "Long", "0 active", "0 archived"]);
    expect(lines[0]!.indexOf("|")).toBe(lines[1]!.indexOf("|"));
  });
});

test("project list reports active and archived counts in text and its JSON contract", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result;
    };
    const app = JSON.parse((await run("project", "create", "APP", "--name", "Application", "--description", "Full\ndescription", "--json")).stdout);
    const empty = JSON.parse((await run("project", "create", "EMPTY", "--json")).stdout);
    const old = JSON.parse((await run("project", "create", "OLD", "--json")).stdout);
    for (const title of ["Backlog", "Done", "Archived"]) {
      await run("task", "create", "APP", "--title", title);
    }
    await run("task", "create", "OLD", "--title", "Old task");
    await run("task", "move", "APP-2", "Done");
    await run("task", "archive", "APP-3", "OLD-1");

    const listed = JSON.parse((await run("project", "list", "--json")).stdout);
    expect(listed).toEqual([
      { ...app, taskCounts: { active: 2, archived: 1 } },
      { ...empty, taskCounts: { active: 0, archived: 0 } },
      { ...old, taskCounts: { active: 0, archived: 1 } },
    ]);
    const text = await run("project", "list");
    expect(text.stdout.trimEnd().split("\n").map((line) => line.split("|").map((cell) => cell.trim()))).toEqual([
      ["APP", "Application", "2 active", "1 archived", "Full description"],
      ["EMPTY", "EMPTY", "0 active", "0 archived"],
      ["OLD", "OLD", "0 active", "1 archived"],
    ]);

    const viewed = JSON.parse((await run("project", "view", "APP", "--json")).stdout);
    expect(viewed.columns.reduce((sum: number, entry: { taskCount: number }) => sum + entry.taskCount, 0)).toBe(listed[0].taskCounts.active);
    expect(viewed.archivedTaskCount).toBe(listed[0].taskCounts.archived);
    expect(viewed).not.toHaveProperty("taskCounts");
    expect(JSON.parse((await run("project", "edit", "APP", "--name", "Edited", "--json")).stdout)).toEqual({
      ...app, name: "Edited", changed: true,
    });
    await run("task", "unarchive", "APP-3");
    await run("task", "delete", "APP-1", "--yes");
    expect(JSON.parse((await run("project", "list", "--json")).stdout)[0].taskCounts).toEqual({ active: 2, archived: 0 });
  });
});

test("project list does not retain a deleted project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    await runZinn(["project", "create", "REMOVE", "--name", "Remove"], testDir);
    expect(
      (await runZinn(["project", "delete", "REMOVE", "--yes"], testDir)).code,
    ).toBe(0);

    const result = await runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("KEEP");
    expect(result.stdout).not.toContain("REMOVE");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

test("project view prints the full description and unarchived task counts per column, with archived tasks as one total", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const description = "Refine the numbers\n  Keep the quota";
    await run("project", "create", "VIEW", "--name", "Project view", "--description", description);
    await run("project", "create", "OTHER");
    await run("task", "create", "OTHER", "--title", "Elsewhere");
    for (const title of ["Backlog task", "First done", "Second done", "Archived task"]) {
      await run("task", "create", "VIEW", "--title", title, "--description", "Task description");
    }
    await run("task", "move", "VIEW-2", "VIEW-3", "Done");
    await run("task", "archive", "VIEW-4");

    const viewedProject = await run("project", "view", "view");

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

test("project view leaves out the Description section and Archived row when there is nothing to show", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTY", "--name", "Empty project"], testDir);

    expect((await runZinn(["project", "view", "EMPTY"], testDir)).stdout).toBe(
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

test("project view JSON contains the project, per-column task counts in board order and the archived total", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    await run("project", "create", "VIEW", "--name", "Project view", "--description", "Full\ndescription");
    await run("task", "create", "VIEW", "--title", "Visible task");
    await run("task", "create", "VIEW", "--title", "Review task");
    await run("task", "move", "VIEW-2", "Review");
    await run("project", "column", "order", "VIEW", "Review", "first");

    const expectedColumns = [
      { id: expect.any(String), name: "Review", taskCount: 1 },
      { id: expect.any(String), name: "Backlog", taskCount: 1 },
      { id: expect.any(String), name: "TODO", taskCount: 0 },
      { id: expect.any(String), name: "In Progress", taskCount: 0 },
      { id: expect.any(String), name: "Done", taskCount: 0 },
    ];
    const viewedProject = await run("project", "view", "VIEW", "--json");

    expect(viewedProject.code).toBe(0);
    expect(JSON.parse(viewedProject.stdout)).toEqual({
      id: expect.any(String),
      key: "VIEW",
      name: "Project view",
      description: "Full\ndescription",
      columns: expectedColumns,
      archivedTaskCount: 0,
    });

    await run("task", "archive", "VIEW-1");
    expect(JSON.parse((await run("project", "view", "VIEW", "--json")).stdout)).toMatchObject({
      columns: [expectedColumns[0], { name: "Backlog", taskCount: 0 }, ...expectedColumns.slice(2)],
      archivedTaskCount: 1,
    });
  });
});

test("project view validates its project key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const missing = await runZinn(["project", "view"], testDir);
    const extra = await runZinn(["project", "view", "ONE", "TWO"], testDir);
    const unknown = await runZinn(["--json", "project", "view", "unknown"], testDir);

    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Usage: zinn project view");
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain(`"TWO"`);
    expect(extra.stderr).toContain("Usage: zinn project view");
    expect(unknown.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unknown.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "UNKNOWN" } });
  });
});

test("project create accepts an alphanumeric key in any casing and stores it uppercase", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "b2B", "--name", "Business"], testDir)).code).toBe(0);

    const result = await runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("B2B | Business | 0 active | 0 archived\n");
  });
});

test("project create rejects keys outside the alphanumeric contract", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    for (const invalidKey of ["2B", "APP-DEV", "APP_DEV", "ÅPP", ""]) {
      const result = await runZinn(["--json", "project", "create", invalidKey, "--name", "Invalid"], testDir);

      expect(result.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["key"] } });
    }
  });
});

test("project create rejects blank or non-single-line names", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    for (const invalidName of ["", "   ", "first line\nsecond line", "name\u001b[31m"]) {
      const result = await runZinn(["--json", "project", "create", "SAFE", "--name", invalidName], testDir);

      expect(result.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["name"] } });
    }
  });
});

// --- TASK

test("task create rejects an unknown project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["--json", "task", "create", "NOPE", "--title", "orphan task"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOPE" } });
  });
});

test("task create requires a project key and a title", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ARGS", "--name", "Args"], testDir);

    expect((await runZinn(["task", "create"], testDir)).stderr).toContain("Usage: zinn task create");
    expect(errorDocumentSchema.parse(JSON.parse((await runZinn(["--json", "task", "create", "ARGS"], testDir)).stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--title" } });
  });
});

test("task create succeeds against an existing project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "TSK", "--name", "Tasks"], testDir);

    const result = await runZinn(["task", "create", "TSK", "--title", "first task"], testDir);

    // The placement contract is asserted independently below.
    expect(result.code).toBe(0);
  });
});

test("task create attaches the task to its project's first ordered column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "PLACE", "--name", "Placed"], testDir);
    await runZinn(["project", "column", "create", "PLACE", "Later"], testDir);

    expect((await runZinn(["task", "create", "PLACE", "--title", "placed task"], testDir)).code).toBe(0);

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

test("task create --column places the task last in the named column, matched case-insensitively", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "COLS", "--name", "Columns"], testDir);

    const first = await runZinn(["task", "create", "COLS", "--title", "first", "--column", "in progress"], testDir);
    const second = await runZinn(["task", "create", "COLS", "--title", "second", "--column", "IN PROGRESS"], testDir);

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

test("task create --column rejects an unknown column and creates nothing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "BADCOL", "--name", "Bad column"], testDir);

    const rejected = await runZinn(["--json", "task", "create", "BADCOL", "--title", "nowhere", "--column", "Nowhere"], testDir);
    const repeated = await runZinn(["--json", "task", "create", "BADCOL", "--title", "twice", "--column", "Done", "--column", "TODO"], testDir);

    expect(rejected.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(rejected.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "column", key: "Nowhere" } });
    expect(repeated.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(repeated.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--column" } });
    expect((await runZinn(["task", "list", "BADCOL"], testDir)).stdout).toBe("");
    expect((await runZinn(["task", "create", "BADCOL", "--title", "real"], testDir)).stdout).toContain(
      "BADCOL-1 | Backlog | - | real",
    );
  });
});

test("task create relation flags relate the new task to existing tasks, from the new task's side", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: string[]) => runZinn(args, testDir);
    await run("project", "create", "APP", "--name", "App");
    await run("project", "create", "OTHER", "--name", "Other");
    for (const title of ["Epic", "Prerequisite", "Sibling", "Original"]) {
      await run("task", "create", "APP", "--title", title);
    }
    await run("task", "create", "OTHER", "--title", "Elsewhere");

    const created = await run(
      "task", "create", "APP", "--title", "Child",
      "--parent", "app-1", "--depends-on", "APP-2", "--depends-on", "OTHER-1",
      "--duplicate-of", "APP-4", "--related", "APP-3",
    );

    expect(created.code).toBe(0);
    expect(created.stdout).toBe("APP-5 | Backlog | - | Child\n");

    const childRelations = (await run("task", "relation", "list", "APP-5")).stdout;
    expect(childRelations).toMatch(/Parent\s+\|\s+APP-1\s+\|\s+Backlog\s+\|\s+Epic/);
    expect(childRelations).toMatch(/Depends on\s+\|\s+APP-2\s+\|\s+Backlog\s+\|\s+Prerequisite/);
    expect(childRelations).toMatch(/Depends on\s+\|\s+OTHER-1\s+\|\s+Backlog\s+\|\s+Elsewhere/);
    expect(childRelations).toMatch(/Duplicate of\s+\|\s+APP-4\s+\|\s+Backlog\s+\|\s+Original/);
    expect(childRelations).toMatch(/Related to\s+\|\s+APP-3\s+\|\s+Backlog\s+\|\s+Sibling/);
    expect((await run("task", "relation", "list", "APP-1")).stdout).toMatch(/Subtask\s+\|\s+APP-5\s+\|\s+Backlog\s+\|\s+Child/);
    expect((await run("task", "relation", "list", "APP-2")).stdout).toMatch(/Depended on by\s+\|\s+APP-5\s+\|\s+Backlog\s+\|\s+Child/);
    expect((await run("task", "relation", "list", "APP-4")).stdout).toMatch(/Duplicated by\s+\|\s+APP-5\s+\|\s+Backlog\s+\|\s+Child/);
    expect((await run("task", "view", "APP-5")).stdout).toMatch(/Parent\s+\|\s+APP-1\s+\|\s+Backlog\s+\|\s+Epic/);

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

test("task create counts identical relation requests once", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: string[]) => runZinn(args, testDir);
    await run("project", "create", "APP", "--name", "App");
    await run("task", "create", "APP", "--title", "Target");

    const created = await run(
      "task", "create", "APP", "--title", "Source",
      "--depends-on", "APP-1", "--depends-on", "app-1",
    );
    const relations = (await run("task", "relation", "list", "APP-2")).stdout.trimEnd().split("\n");

    expect(created.code).toBe(0);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatch(/Depends on\s+\|\s+APP-1\s+\|\s+Backlog\s+\|\s+Target/);
  });
});

test("task create rejects a missing, malformed or repeated relation target and creates nothing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: string[]) => runZinn(args, testDir);
    await run("project", "create", "APP", "--name", "App");
    await run("task", "create", "APP", "--title", "Epic");
    await run("task", "create", "APP", "--title", "Other epic");
    const countRows = () =>
      withTestDb(testDir, (db) =>
        db
          .query(
            "SELECT (SELECT COUNT(*) FROM task) AS tasks, (SELECT COUNT(*) FROM activity) AS activities, (SELECT COUNT(*) FROM task_relations) AS relations",
          )
          .get(),
      );
    const before = countRows();

    const missing = await run("--json", "task", "create", "APP", "--title", "Lost", "--parent", "APP-1", "--depends-on", "APP-99");
    const missingProject = await run("--json", "task", "create", "APP", "--title", "Lost", "--related", "NOPE-1");
    const malformed = await run("--json", "task", "create", "APP", "--title", "Lost", "--depends-on", "APP-1", "--related", "nope");
    const secondParent = await run("--json", "task", "create", "APP", "--title", "Lost", "--parent", "APP-1", "--parent", "APP-2");
    const secondDuplicate = await run("--json", "task", "create", "APP", "--title", "Lost", "--duplicate-of", "APP-1", "--duplicate-of", "APP-2");

    expect(missing.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(missing.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: "APP-99" } });
    expect(missingProject.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(missingProject.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOPE" } });
    expect(malformed.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(malformed.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("nope"), details: { field: ["taskKey"] } });
    expect(secondParent.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(secondParent.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--parent" } });
    expect(secondDuplicate.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(secondDuplicate.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--duplicate-of" } });
    expect(countRows()).toEqual(before);
    expect((await run("task", "create", "APP", "--title", "Real")).stdout).toBe("APP-3 | Backlog | - | Real\n");
  });
});

test("task create help lists the relation flags", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const help = await runZinn(["task", "create", "--help"], testDir);

    expect(help.code).toBe(0);
    for (const flag of ["--parent <task-key>", "--depends-on <task-key>", "--duplicate-of <task-key>", "--related <task-key>"]) {
      expect(help.stdout).toContain(flag);
    }
  });
});

test("task ordering starts independently in each column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    await runZinn(["task", "create", "ALPHA", "--title", "todo first"], testDir);

    withTestDb(testDir, (db) => {
      const todoColumn = db
        .query<{ id: string }, []>("SELECT id FROM project_column WHERE name = 'TODO'")
        .get();

      expect(todoColumn).not.toBeNull();
      db.run("UPDATE task SET column_id = ? WHERE title = 'todo first'", [todoColumn!.id]);
    });

    await runZinn(["task", "create", "ALPHA", "--title", "backlog first"], testDir);
    await runZinn(["task", "create", "ALPHA", "--title", "backlog second"], testDir);

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

test("a project without columns rejects task creation without consuming a task number", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTYCOL", "--name", "No columns"], testDir);
    withTestDb(testDir, (db) => db.run("DELETE FROM project_column"));

    const rejected = await runZinn(["--json", "task", "create", "EMPTYCOL", "--title", "cannot place me"], testDir);

    expect(rejected.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(rejected.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "no_columns", entity: "project", key: "EMPTYCOL" } });

    await runZinn(["project", "column", "create", "EMPTYCOL", "Inbox"], testDir);
    expect((await runZinn(["task", "create", "EMPTYCOL", "--title", "first real task"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "view", "EMPTYCOL-1"], testDir)).stdout).toContain(
      "EMPTYCOL-1 | Inbox | - | first real task",
    );
  });
});

test("task list on an empty database exits cleanly without output", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["task", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("task list --column filters project and global results with labels and archive flags", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const keys = async (...args: Array<string>) => {
      const result = await run("task", "list", ...args, "--json");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout).map((row: { key: string }) => row.key);
    };
    expect((await run("project", "create", "AAA")).code).toBe(0);
    expect((await run("project", "create", "BBB")).code).toBe(0);
    expect((await run("label", "create", "CLI")).code).toBe(0);
    expect((await run("label", "create", "Groom")).code).toBe(0);
    expect((await run("task", "create", "AAA", "--title", "Both", "--column", "In Progress", "--label", "CLI", "--label", "Groom")).code).toBe(0);
    expect((await run("task", "create", "AAA", "--title", "CLI only", "--column", "In Progress", "--label", "CLI")).code).toBe(0);
    expect((await run("task", "create", "AAA", "--title", "Elsewhere", "--label", "CLI", "--label", "Groom")).code).toBe(0);
    expect((await run("task", "create", "BBB", "--title", "Archived", "--column", "In Progress", "--label", "CLI", "--label", "Groom")).code).toBe(0);
    expect((await run("task", "archive", "BBB-1")).code).toBe(0);

    expect(await keys("--column", "IN PROGRESS")).toEqual(["AAA-1", "AAA-2"]);
    expect(await keys("AAA", "--column", "in progress", "--label", "cli", "--label", "GROOM")).toEqual(["AAA-1"]);
    expect(await keys("--column", "In Progress", "--archived", "--label", "CLI", "--label", "Groom")).toEqual(["BBB-1"]);
    expect(await keys("--column", "In Progress", "--all", "--label", "CLI", "--label", "Groom")).toEqual(["AAA-1", "BBB-1"]);
    const unfiltered = JSON.parse((await run("task", "list", "--all", "--json")).stdout);
    const filtered = JSON.parse((await run("task", "list", "--column", "In Progress", "--all", "--json")).stdout);
    expect(filtered).toEqual(unfiltered.filter((row: { column: string }) => row.column === "In Progress"));
    const text = await run("task", "list", "AAA", "--column", "In Progress");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("AAA-1");
    expect(text.stdout).toContain("AAA-2");
    expect(text.stdout).not.toContain("AAA-3");

    for (const scope of [[], ["AAA"]]) {
      for (const name of ["Nowhere", "Review", "Progress"]) {
        expect(await keys(...scope, "--column", name)).toEqual([]);
        expect(await run("task", "list", ...scope, "--column", name)).toEqual({ stdout: "", stderr: "", code: 0 });
      }
    }
    const repeated = await run("--json", "task", "list", "--column", "Review", "--column", "Done");
    expect(repeated.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(repeated.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--column" } });
    expect((await run("task", "list", "--help")).stdout).toContain("[--column <name>]");
  });
});

test("task list renders every project's tasks once and aligns unequal key widths", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "a", "--name", "Short"], testDir);
    await runZinn(["project", "create", "LONGKEY", "--name", "Long"], testDir);
    await runZinn(["task", "create", "A", "--title", "short task", "--description", "short description"], testDir);
    await runZinn(["task", "create", "LONGKEY", "--title", "long task", "--description", "long description"], testDir);

    const result = await runZinn(["task", "list"], testDir);
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

test("task list does not print a missing description as data", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "NONE", "--name", "No description"], testDir);
    await runZinn(["task", "create", "NONE", "--title", "title only"], testDir);

    const result = await runZinn(["task", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`NONE-1 | Backlog | - | title only`);
    expect(result.stdout).not.toContain("null");
  });
});

test("task list leaves a long multi-line description to task view, which prints it in full", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "PREVIEW", "--name", "Description preview"], testDir);
    const description = `${"A".repeat(40)}\n\t${"B".repeat(50)}`;

    await runZinn(
      ["task", "create", "PREVIEW", "--title", "long description", "--description", description],
      testDir,
    );

    const listResult = await runZinn(["task", "list", "PREVIEW"], testDir);
    const viewResult = await runZinn(["task", "view", "PREVIEW-1"], testDir);

    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toBe(`PREVIEW-1 | Backlog | - | long description\n`);
    expect(viewResult.code).toBe(0);
    expect(taskViewContent(viewResult.stdout)).toBe(
      `PREVIEW-1 | Backlog | - | long description\n\n${SECTION_RULE}\nDescription:\n${description}\n`,
    );
  });
});

test("task rows in lists and bulk archive output leave descriptions out, while JSON keeps them", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const descriptions = ["First hidden description", "Second hidden description"];
    await run("project", "create", "ROWS");
    await run("task", "create", "ROWS", "--title", "First", "--description", descriptions[0]!);
    await run("task", "create", "ROWS", "--title", "Second", "--description", descriptions[1]!);

    const rowOutputs = [
      await run("task", "list", "ROWS"),
      await run("task", "archive", "ROWS-1", "ROWS-2"),
      await run("task", "list", "ROWS", "--all"),
      await run("task", "unarchive", "ROWS-1", "ROWS-2"),
    ];

    for (const rowOutput of rowOutputs) {
      expect(rowOutput.code).toBe(0);
      expect(rowOutput.stdout).toContain("ROWS-1");
      expect(rowOutput.stdout).not.toContain("hidden description");
    }

    const listedJson = JSON.parse((await run("task", "list", "ROWS", "--json")).stdout);
    const archivedJson = JSON.parse((await run("task", "archive", "ROWS-1", "ROWS-2", "--json")).stdout);
    expect(listedJson.map((entry: { description: string }) => entry.description)).toEqual(descriptions);
    expect(archivedJson.map((entry: { description: string }) => entry.description)).toEqual(descriptions);
  });
});

test("task list filters to the requested project regardless of key casing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    await runZinn(["project", "create", "BETA", "--name", "Beta"], testDir);
    await runZinn(["task", "create", "ALPHA", "--title", "alpha task"], testDir);
    await runZinn(["task", "create", "BETA", "--title", "beta task"], testDir);

    const result = await runZinn(["task", "list", "aLpHa"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`ALPHA-1 | Backlog | - | alpha task`);
    expect(result.stdout).not.toContain("beta task");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

test("project-scoped task list aligns column names and follows board order", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ORDER", "--name", "Ordered"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "todo first"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "backlog first"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "in progress"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "todo second"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "backlog second"], testDir);

    await runZinn(["task", "move", "ORDER-1", "TODO"], testDir);
    await runZinn(["task", "move", "ORDER-3", "In Progress"], testDir);
    await runZinn(["task", "move", "ORDER-4", "TODO"], testDir);

    const result = await runZinn(["task", "list", "ORDER"], testDir);

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

test("task list for an empty project does not leak another project's tasks", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTY", "--name", "Empty"], testDir);
    await runZinn(["project", "create", "BUSY", "--name", "Busy"], testDir);
    await runZinn(["task", "create", "BUSY", "--title", "private task"], testDir);

    const result = await runZinn(["task", "list", "EMPTY"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("task list rejects an unknown project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["--json", "task", "list", "NOSUCH"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOSUCH" } });
  });
});

test("task list and search filter by every repeated label", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    await run("project", "create", "FILTER");
    await run("label", "create", "CLI");
    await run("label", "create", "Groom");
    await run("task", "create", "FILTER", "--title", "Both labels", "--label", "CLI", "--label", "Groom");
    await run("task", "create", "FILTER", "--title", "CLI only", "--label", "CLI");
    await run("task", "create", "FILTER", "--title", "Groom only", "--label", "Groom");
    await run("task", "archive", "FILTER-3");

    const listed = JSON.parse(
      (await run("task", "list", "FILTER", "--label", "cli", "--label", "GROOM", "--json")).stdout,
    );
    expect(listed.map((entry: { key: string }) => entry.key)).toEqual(["FILTER-1"]);

    const searched = await run(
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

    const archived = await run("task", "list", "FILTER", "--archived", "--label", "groom");
    expect(archived.stdout).toContain("FILTER-3");
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "list", "--label", "missing")).stderr)).error).toMatchObject({ code: "not_found", details: { entity: "label", key: "missing" } });
    expect((await run("task", "search", "labels", "--label", "missing")).code).toBe(1);
  });
});

test("project-scoped task list aligns one- and two-digit task numbers", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "TEN", "--name", "Ten tasks"], testDir);
    for (let number = 1; number <= 10; number++) {
      await runZinn(["task", "create", "TEN", "--title", `task ${number}`], testDir);
    }

    const result = await runZinn(["task", "list", "TEN"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(lines).toHaveLength(10);
    expect(lines).toContain(`TEN-1  | Backlog | - | task 1`);
    expect(lines).toContain(`TEN-10 | Backlog | - | task 10`);
  });
});

test("task list prints labels after the title, and a task without labels ends at its title", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    await run("project", "create", "TAGS");
    await run("label", "create", "bug");
    await run("label", "create", "cli");
    await run("label", "create", "docs");
    await run("task", "create", "TAGS", "--title", "No labels");
    await run("task", "create", "TAGS", "--title", "One label", "--label", "bug");
    await run("task", "create", "TAGS", "--title", "Several labels", "--label", "bug", "--label", "cli", "--label", "docs");

    const result = await run("task", "list", "TAGS");

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

test("task view exposes stored timestamps after its content and history, using local UTC offsets", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir, { TZ: "Europe/Berlin" });
    expect((await run("project", "create", "TIME")).code).toBe(0);
    const created = await run("task", "create", "TIME", "--title", "Timestamped", "--description", "Details", "--json");
    expect(created.code).toBe(0);
    expect((await run("task", "create", "TIME", "--title", "Other")).code).toBe(0);
    expect((await run("task", "comment", "create", "TIME-1", "--text", "A comment")).code).toBe(0);
    expect((await run("task", "relation", "create", "TIME-1", "TIME-2", "--type", "related")).code).toBe(0);
    const createdAt = Date.UTC(2026, 0, 15, 10, 7);
    const updatedAt = Date.UTC(2026, 6, 15, 9, 42);
    withTestDb(dir, (db) => {
      db.run("UPDATE task SET created_at = ?, updated_at = ? WHERE number = 1", [createdAt, updatedAt]);
    });
    const activityBefore = (await run("activity", "list", "--project", "TIME", "--json")).stdout;

    for (const history of [[], ["--history"]]) {
      const viewed = await run("task", "view", "TIME-1", ...history);
      expect(viewed.code).toBe(0);
      expect(viewed.stderr).toBe("");
      const lastLine = viewed.stdout.trimEnd().split("\n").at(-1)!;
      expect(lastLine).toContain("Task");
      expect(lastLine).toContain("2026-01-15 11:07 +01:00");
      expect(lastLine).toContain("2026-07-15 11:42 +02:00");
      const json = await run("task", "view", "TIME-1", ...history, "--json");
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ created_at: createdAt, updated_at: updatedAt });
    }
    expect((await run("activity", "list", "--project", "TIME", "--json")).stdout).toBe(activityBefore);

    for (const result of [
      JSON.parse(created.stdout),
      JSON.parse((await run("task", "list", "TIME", "--json")).stdout)[0],
      JSON.parse((await run("task", "search", "Timestamped", "TIME", "--json")).stdout)[0],
      JSON.parse((await run("task", "edit", "TIME-1", "--title", "Timestamped", "--json")).stdout),
    ]) {
      expect(Object.hasOwn(result, "created_at")).toBe(false);
      expect(Object.hasOwn(result, "updated_at")).toBe(false);
    }

    expect((await run("task", "comment", "create", "TIME-1", "--text", "Another comment")).code).toBe(0);
    expect((await run("task", "relation", "delete", "TIME-1", "TIME-2", "--type", "related")).code).toBe(0);
    const unchanged = JSON.parse((await run("task", "view", "TIME-1", "--json")).stdout);
    expect(unchanged).toMatchObject({ created_at: createdAt, updated_at: updatedAt });
    expect((await run("task", "edit", "TIME-1", "--title", "Changed")).code).toBe(0);
    const changed = JSON.parse((await run("task", "view", "TIME-1", "--json")).stdout);
    expect(changed.created_at).toBe(createdAt);
    expect(changed.updated_at).toBeGreaterThan(updatedAt);
    expect(withTestDb(dir, (db) => db.query("SELECT updated_at FROM task WHERE number = 1").get()))
      .toEqual({ updated_at: changed.updated_at });
  });
});

test("task view resolves a case-insensitive key and prints its canonical form", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "VIEW", "--name", "Viewed"], testDir);
    await runZinn(["task", "create", "VIEW", "--title", "visible task", "--description", "visible description"], testDir);

    const result = await runZinn(["task", "view", "vIeW-1"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(taskViewContent(result.stdout)).toBe(
      `VIEW-1 | Backlog | - | visible task\n\n${SECTION_RULE}\nDescription:\nvisible description\n`,
    );
  });
});

test("task view prints the task row followed by Description, Relations, and Comments sections", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir, { TZ: "Europe/Berlin" });
    const description = "First line of the description.\nSecond line.";
    await run("project", "create", "MDR");
    await run("label", "create", "bug");
    await run("label", "create", "cli");
    await run("task", "create", "MDR", "--title", "Refine the numbers", "--description", description, "--priority", "high", "--label", "cli", "--label", "bug");
    await run("task", "create", "MDR", "--title", "Check the totals");
    await run("task", "relation", "create", "MDR-1", "MDR-2", "--type", "dependency");
    await run("task", "comment", "create", "MDR-1", "--text", "Ready for review");
    await run("task", "move", "MDR-1", "In Progress");
    const commentedAt = Date.UTC(2026, 8, 25, 17, 42);
    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ?, updated_at = ?", [commentedAt, commentedAt]);
    });

    const viewed = await run("task", "view", "MDR-1");

    expect(viewed.code).toBe(0);
    expect(viewed.stderr).toBe("");
    expect(taskViewContent(viewed.stdout)).toBe(
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

    expect(JSON.parse((await run("task", "view", "MDR-1", "--json")).stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "MDR-1",
      status: "Active",
      column: "In Progress",
      title: "Refine the numbers",
      description,
      priority: "high",
      labels: ["bug", "cli"],
      label_ids: [expect.any(String), expect.any(String)],
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      relations: [
        {
          id: expect.any(String),
          type: "dependency",
          direction: "outgoing",
          task: { id: expect.any(String), project_id: expect.any(String), column_id: expect.any(String), key: "MDR-2", column: "Backlog", title: "Check the totals", status: "Active" },
        },
      ],
      comments: [
        { id: expect.any(String), task_id: expect.any(String), key: "MDR-1#1", text: "Ready for review", created_at: commentedAt, updated_at: commentedAt },
      ],
    });
  });
});

test("task view leaves out the Description section for a task without a description", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "NONE", "--name", "No description"], testDir);
    await runZinn(["task", "create", "NONE", "--title", "title only"], testDir);
    await runZinn(["task", "create", "NONE", "--title", "other task"], testDir);

    const result = await runZinn(["task", "view", "NONE-1"], testDir);

    expect(result.code).toBe(0);
    expect(taskViewContent(result.stdout)).toBe(`NONE-1 | Backlog | - | title only\n`);

    await runZinn(["task", "relation", "create", "NONE-1", "NONE-2", "--type", "related"], testDir);
    expect(taskViewContent((await runZinn(["task", "view", "NONE-1"], testDir)).stdout)).toBe(
      `NONE-1 | Backlog | - | title only\n\n${SECTION_RULE}\nRelations:\nRelated to | NONE-2 | Backlog | other task\n`,
    );
  });
});

test.serial("task view sizes section rules to the terminal even when color is disabled", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "W"], dir);
    const description = "中文 🧑‍🌾\n  Keep this indentation";
    await runZinn(["task", "create", "W", "--title", "Width", "--description", description], dir);
    await runZinn(["task", "create", "W", "--title", "Other"], dir);
    await runZinn(["task", "relation", "create", "W-1", "W-2", "--type", "related"], dir);
    await runZinn(["task", "comment", "create", "W-1", "--text", "A comment"], dir);

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

    const piped = await runZinn(["task", "view", "W-1"], dir, { COLUMNS: "160", FORCE_COLOR: "0" });
    expect(piped.stdout.split("\n").filter((line) => line === SECTION_RULE)).toHaveLength(3);
  });
});

test("task view of an archived task shows Archived after the key and full priority", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    await run("project", "create", "MDR");
    await run("label", "create", "bug");
    await run("task", "create", "MDR", "--title", "Refine the numbers", "--description", "Shelved", "--priority", "high", "--label", "bug");
    await run("task", "archive", "MDR-1");

    const archivedRow = "MDR-1 | Archived | Backlog | H | Refine the numbers | bug";
    expect((await run("task", "list", "MDR", "--all")).stdout).toBe(`${archivedRow}\n`);
    expect(taskViewContent((await run("task", "view", "MDR-1")).stdout)).toBe(`MDR-1 | Archived | Backlog | High | Refine the numbers | bug\n\n${SECTION_RULE}\nDescription:\nShelved\n`);

    await run("task", "unarchive", "MDR-1");
    expect(taskViewContent((await run("task", "view", "MDR-1")).stdout)).toBe(
      `MDR-1 | Backlog | High | Refine the numbers | bug\n\n${SECTION_RULE}\nDescription:\nShelved\n`,
    );
  });
});

test("human task output omits empty descriptions while JSON returns null", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTY", "--name", "Empty description"], testDir);

    const created = await runZinn(
      ["task", "create", "EMPTY", "--title", "Empty description", "--description", ""],
      testDir,
    );
    expect(created.stdout).toBe(`EMPTY-1 | Backlog | - | Empty description\n`);

    expect((await runZinn(["task", "list", "EMPTY"], testDir)).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );
    expect((await runZinn(["task", "search", "Empty", "EMPTY"], testDir)).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );
    expect(taskViewContent((await runZinn(["task", "view", "EMPTY-1"], testDir)).stdout)).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );

    await runZinn(["task", "edit", "EMPTY-1", "--description", "Visible"], testDir);
    expect((await runZinn(["task", "edit", "EMPTY-1", "--description", ""], testDir)).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );

    expect(JSON.parse((await runZinn(["task", "list", "EMPTY", "--json"], testDir)).stdout)).toEqual([
      expect.objectContaining({ key: "EMPTY-1", description: null }),
    ]);
  });
});

test.serial("task move, list and view color workflow column names only in a terminal, while JSON stays raw", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "COLOR", "--name", "Column colors"], testDir);
    await runZinn(["task", "create", "COLOR", "--title", "waiting"], testDir);
    await runZinn(["task", "create", "COLOR", "--title", "finished"], testDir);

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
    expect((await runZinn(["task", "list", "COLOR"], testDir)).stdout).toBe(
      ["COLOR-1 | Backlog | - | waiting", "COLOR-2 | Done    | - | finished", ""].join("\n"),
    );
    expect(taskViewContent((await runZinn(["task", "view", "COLOR-2"], testDir)).stdout)).toBe("COLOR-2 | Done | - | finished\n");
    expect((await runZinn(["task", "move", "COLOR-2", "Done"], testDir)).stdout).toBe(
      "COLOR-2 | Done | - | finished\n",
    );

    const listedJson = (await runZinn(["task", "list", "COLOR", "--json"], testDir)).stdout;
    expect(listedJson).not.toContain("\x1b");
    expect(JSON.parse(listedJson).map((task: { column: string }) => task.column)).toEqual([
      "Backlog",
      "Done",
    ]);
  });
});

test("task view requires a task key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["task", "view"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: zinn task view");
  });
});

test("task view rejects malformed task keys with an actionable error", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    for (const invalidKey of ["VIEW", "VIEW-", "VIEW-one", "VIEW-1-extra"]) {
      const result = await runZinn(["--json", "task", "view", invalidKey], testDir);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining(invalidKey), details: { field: ["taskKey"] } });

    }

    // ? ZINN-51: a word that begins with a dash is read as a word only after --.
    const dashKey = await runZinn(["--json", "task", "view", "--", "-1"], testDir);
    expect(dashKey.code).toBe(1);
    expect(dashKey.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(dashKey.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("-1"), details: { field: ["taskKey"] } });

  });
});

test("task view distinguishes an unknown project from an unknown task number", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KNOWN", "--name", "Known"], testDir);

    const unknownProject = await runZinn(["--json", "task", "view", "NOPE-1"], testDir);
    const unknownTask = await runZinn(["--json", "task", "view", "KNOWN-99"], testDir);

    expect(unknownProject.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unknownProject.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOPE" } });
    expect(unknownTask.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unknownTask.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: "KNOWN-99" } });
  });
});

test("task and comment key numbers are capped at 15 digits", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "CAP", "--name", "Cap"], testDir);
    await runZinn(["task", "create", "CAP", "--title", "Only task"], testDir);

    const tooManyDigits = "9".repeat(20);
    const fifteenDigits = "9".repeat(15);

    // 16+ digits: rejected as a malformed key, never rounded and looked up.
    const invalidTask = await runZinn(["--json", "task", "view", `CAP-${tooManyDigits}`], testDir);
    expect(errorDocumentSchema.parse(JSON.parse(invalidTask.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining(`CAP-${tooManyDigits}`), details: { field: ["taskKey"] } });

    const invalidComment = await runZinn(["--json", "task", "comment", "edit", `CAP-1#${tooManyDigits}`, "--text", "x"], testDir);
    expect(errorDocumentSchema.parse(JSON.parse(invalidComment.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining(`CAP-1#${tooManyDigits}`), details: { field: ["commentKey"] } });

    // Exactly 15 digits: still a well-formed key (an exact JS integer), just not found.
    const missingTask = await runZinn(["--json", "task", "view", `CAP-${fifteenDigits}`], testDir);
    expect(errorDocumentSchema.parse(JSON.parse(missingTask.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: `CAP-${fifteenDigits}` } });

    const missingComment = await runZinn(["--json", "task", "comment", "edit", `CAP-1#${fifteenDigits}`, "--text", "x"], testDir);
    expect(errorDocumentSchema.parse(JSON.parse(missingComment.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "comment", key: `CAP-1#${fifteenDigits}` } });
  });
});

test("task comments can be created, listed, edited, viewed, and deleted", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "NOTE"], testDir);
    await runZinn(["task", "create", "NOTE", "--title", "Commented task"], testDir);

    const first = await runZinn(
      ["task", "comment", "create", "NOTE-1", "--text", "First comment"],
      testDir,
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("NOTE-1#1 | First comment\n");

    const second = JSON.parse(
      (await runZinn(
        ["task", "comment", "create", "note-1", "--text", "Second comment", "--json"],
        testDir,
      )).stdout,
    );
    expect(second).toEqual({
      id: expect.any(String),
      task_id: expect.any(String),
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
      (await runZinn(["task", "comment", "list", "NOTE-1"], testDir, {
        TZ: "Europe/Berlin",
      })).stdout,
    ).toBe(
      "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment\n" +
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Second comment\n",
    );

    expect(
      (await runZinn(
        ["task", "comment", "edit", second.key, "--text", "Edited second"],
        testDir,
      )).stdout,
    ).toBe("NOTE-1#2 | Edited second\n");

    const viewed = await runZinn(["task", "view", "NOTE-1"], testDir, {
      TZ: "Europe/Berlin",
    });
    expect(viewed.stdout).toContain(
      `\n\n${SECTION_RULE}\nComments:\n` +
        "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment\n" +
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Edited second\n",
    );

    const viewedJson = JSON.parse(
      (await runZinn(["task", "view", "NOTE-1", "--json"], testDir)).stdout,
    );
    expect(viewedJson.comments.map((entry: { key: string }) => entry.key)).toEqual([
      "NOTE-1#1",
      "NOTE-1#2",
    ]);

    const deleted = await runZinn(["task", "comment", "delete", "NOTE-1#2", "--yes"], testDir);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain("NOTE-1#2");

    expect(
      (await runZinn(["task", "comment", "create", "NOTE-1", "--text", "Third comment"], testDir))
        .stdout,
    ).toBe("NOTE-1#3 | Third comment\n");

    expect(
      (await runZinn(["task", "comment", "create", "NOTE-1", "--text", "Line one\nLine two"], testDir))
        .stdout,
    ).toBe("NOTE-1#4 | Line one…\n");

    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 4", [
        Date.UTC(2026, 8, 25, 18, 7),
      ]);
    });

    const multilinePrefix = "NOTE-1#4 | 2026-09-25 20:07 +02:00 | ";
    expect(
      (await runZinn(["task", "comment", "list", "NOTE-1"], testDir, {
        TZ: "Europe/Berlin",
      })).stdout,
    ).toContain(`${multilinePrefix}Line one\n${" ".repeat(multilinePrefix.length)}Line two\n`);
  });
});

test("comment create and edit cap human echoes while reads and JSON retain the full text", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "NOTE")).code).toBe(0);
    expect((await run("task", "create", "NOTE", "--title", "Commented task")).code).toBe(0);

    const cases = [
      { text: "Short comment", preview: "Short comment" },
      { text: "x".repeat(80), preview: "x".repeat(80) },
      { text: "x".repeat(81), preview: `${"x".repeat(79)}…` },
      { text: "First line\nLater text", preview: "First line…" },
      { text: `${"x".repeat(80)}\r\nLater text`, preview: `${"x".repeat(79)}…` },
      { text: "\nLater text", preview: "…" },
    ];
    for (const { text, preview } of cases) {
      const created = await run("task", "comment", "create", "NOTE-1", "--text", text);
      expect(created.code).toBe(0);
      expect(created.stderr).toBe("");
      expect(created.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(created.stdout).toEndWith(` | ${preview}\n`);

      const key = created.stdout.split(" | ")[0]!;
      const storedText = text.replaceAll("\r\n", "\n");
      const json = await run("task", "comment", "create", "NOTE-1", "--text", text, "--json");
      expect(json.code).toBe(0);
      expect(json.stderr).toBe("");
      const jsonComment = JSON.parse(json.stdout);
      expect(jsonComment).toEqual({
        id: expect.any(String),
        task_id: expect.any(String),
        key: expect.stringMatching(/^NOTE-1#\d+$/),
        text: storedText,
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      });

      const editText = `Edited ${text}`;
      const edited = await run("task", "comment", "edit", key, "--text", editText);
      expect(edited.code).toBe(0);
      expect(edited.stderr).toBe("");
      const echo = edited.stdout.slice(`${key} | `.length).trimEnd();
      expect(edited.stdout).toStartWith(`${key} | `);
      expect(echo.split("\n")).toHaveLength(1);
      expect(echo.length).toBeLessThanOrEqual(80);
      if (editText.length > 80 || editText.includes("\n")) {
        expect(echo).toEndWith("…");
      } else {
        expect(echo).toBe(editText);
      }

      const editedJson = await run("task", "comment", "edit", key, "--text", text, "--json");
      expect(editedJson.code).toBe(0);
      expect(editedJson.stderr).toBe("");
      const { changed, ...comment } = JSON.parse(editedJson.stdout);
      expect(changed).toBe(true);
      expect(comment).toEqual({
        id: expect.any(String), task_id: expect.any(String), key, text: storedText, created_at: expect.any(Number), updated_at: expect.any(Number),
      });
      const viewed = await run("task", "comment", "view", key, "--json");
      expect(viewed.code).toBe(0);
      expect(JSON.parse(viewed.stdout)).toEqual(comment);
    }

    const fullText = "First line\n" + "Full comment text. ".repeat(20);
    const created = await run("task", "comment", "create", "NOTE-1", "--text", fullText, "--json");
    const { key } = JSON.parse(created.stdout);
    for (const args of [
      ["task", "comment", "view", key],
      ["task", "comment", "list", "NOTE-1"],
      ["task", "view", "NOTE-1"],
    ]) {
      const result = await run(...args);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(fullText.split("\n")[1]!);
    }
  });
});

test("Unicode characters stay intact at comment, label and project preview cutoffs", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "NOTE")).code).toBe(0);
    expect((await run("task", "create", "NOTE", "--title", "Commented task")).code).toBe(0);
    expect((await run("task", "comment", "create", "NOTE-1", "--text", "Initial text")).code).toBe(0);
    expect((await run("label", "create", "bug")).code).toBe(0);

    const cases = [
      { text: `${"x".repeat(78)}😀z`, preview: `${"x".repeat(78)}…` },
      { text: `${"x".repeat(77)}😀zz`, preview: `${"x".repeat(77)}😀…` },
      { text: `${"x".repeat(78)}😀`, preview: `${"x".repeat(78)}😀` },
      { text: `${"x".repeat(78)}😀\nLater text`, preview: `${"x".repeat(78)}…` },
      { text: `${"x".repeat(78)}e\u0301zz`, preview: `${"x".repeat(78)}e\u0301…` },
      { text: `${"x".repeat(78)}👨‍👩‍👧‍👦z`, preview: `${"x".repeat(78)}…` },
      { text: `${"界".repeat(40)}z`, preview: `${"界".repeat(39)}…` },
    ];
    for (const [index, { text, preview }] of cases.entries()) {
      const commands = [
        ["task", "comment", "create", "NOTE-1", "--text"],
        ["task", "comment", "edit", "NOTE-1#1", "--text"],
        ["label", "create", `label-${index}`, "--description"],
        ["label", "edit", "bug", "--description"],
        ["project", "create", `P${index}`, "--description"],
        ["project", "edit", "NOTE", "--description"],
      ];
      for (const args of commands) {
        const result = await run(...args, text);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toEndWith(` | ${preview}\n`);
        expect(result.stdout).not.toContain("\uFFFD");
      }

      const listed = await run("label", "list");
      expect(listed.code).toBe(0);
      expect(listed.stderr).toBe("");
      expect(listed.stdout).toContain(` | ${preview}\n`);
      expect(listed.stdout).not.toContain("\uFFFD");

      const projectList = await run("project", "list");
      expect(projectList.code).toBe(0);
      expect(projectList.stdout).toContain(` | ${preview}\n`);
      expect(projectList.stdout).not.toContain("\uFFFD");

      const commentView = await run("task", "comment", "view", "NOTE-1#1");
      for (const line of text.split("\n")) {
        expect(commentView.stdout).toContain(line);
      }
      const labelView = await run("label", "view", "bug");
      expect(labelView.stdout).toContain(text);
      const projectView = await run("project", "view", "NOTE");
      expect(projectView.stdout).toContain(text);

      const comment = await run("task", "comment", "view", "NOTE-1#1", "--json");
      expect(comment.code).toBe(0);
      expect(JSON.parse(comment.stdout).text).toBe(text);
      const labels = await run("label", "list", "--json");
      expect(labels.code).toBe(0);
      expect(JSON.parse(labels.stdout)).toContainEqual({ id: expect.any(String), name: "bug", color: "white", description: text });
      const project = await run("project", "view", "NOTE", "--json");
      expect(project.code).toBe(0);
      expect(JSON.parse(project.stdout).description).toBe(text);
    }
  });
});

test("task comment view reads only the requested current comment, including on archived tasks, without writes", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "NOTE")).code).toBe(0);
    expect((await run("task", "create", "NOTE", "--title", "Commented task")).code).toBe(0);
    expect((await run("task", "comment", "create", "NOTE-1", "--text", "Sibling comment")).code).toBe(0);
    expect((await run("task", "comment", "create", "NOTE-1", "--text", "Original text")).code).toBe(0);
    const text = "  Current first line\n\tSecond line\n" + "Full comment text. ".repeat(40) + "\n";
    const edited = await run("task", "comment", "edit", "NOTE-1#2", "--text", text, "--json");
    expect(edited.code).toBe(0);
    const { changed, ...expected } = JSON.parse(edited.stdout);
    expect(changed).toBe(true);
    const snapshot = () => withTestDb(directory, (db) => ({
      comments: db.query("SELECT * FROM comment ORDER BY id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));

    for (const archived of [false, true]) {
      if (archived) {
        expect((await run("task", "archive", "NOTE-1")).code).toBe(0);
      }
      const before = snapshot();
      const viewed = await run("task", "comment", "view", "note-1#2");
      expect(viewed.code).toBe(0);
      expect(viewed.stderr).toBe("");
      expect(viewed.stdout).toContain("NOTE-1#2");
      for (const line of text.trimEnd().split("\n")) {
        expect(viewed.stdout).toContain(line);
      }
      expect(viewed.stdout).not.toContain("Sibling comment");
      expect(viewed.stdout).not.toContain("Original text");

      const viewedJson = await run("task", "comment", "view", "note-1#2", "--json");
      expect(viewedJson.code).toBe(0);
      expect(viewedJson.stderr).toBe("");
      const data = JSON.parse(viewedJson.stdout);
      expect(data).toEqual({
        id: expected.id, task_id: expected.task_id, key: "NOTE-1#2", text, created_at: expected.created_at, updated_at: expected.updated_at,
      });
      expect(snapshot()).toEqual(before);
    }
  });
});

test("task comment view rejects malformed, missing and deleted comments with structured errors", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "NOTE")).code).toBe(0);
    expect((await run("task", "create", "NOTE", "--title", "Commented task")).code).toBe(0);
    expect((await run("task", "comment", "create", "NOTE-1", "--text", "Deleted text")).code).toBe(0);
    expect((await run("task", "comment", "delete", "NOTE-1#1", "--yes")).code).toBe(0);

    const cases = [
      { key: "NOTE-1", code: "invalid_input", details: { field: ["commentKey"] } },
      { key: "NOTE-1#1", code: "not_found", details: { entity: "comment", key: "NOTE-1#1" } },
      { key: "NOTE-1#2", code: "not_found", details: { entity: "comment", key: "NOTE-1#2" } },
      { key: "NOTE-2#1", code: "not_found", details: { entity: "task", key: "NOTE-2" } },
    ];
    for (const { key, code, details } of cases) {
      for (const json of [false, true]) {
        const flags = json ? ["--json"] : [];
        const result = await run("task", "comment", "view", key, ...flags);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toBe("");
        if (json) {
          expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code, details });
        }
      }
    }
  });
});

test("comment lists pad the key so #1 lines up with #10 and keep continuation lines under the text", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "PAD"], testDir);
    await runZinn(["task", "create", "PAD", "--title", "Many comments"], testDir);

    const createComment = (number: number) => {
      const isMultiline = number === 1 || number === 10;
      const text = isMultiline ? `Comment ${number}\nsecond line` : `Comment ${number}`;

      return runZinn(["task", "comment", "create", "PAD-1", "--text", text], testDir);
    };
    for (let number = 1; number <= 9; number += 1) {
      await createComment(number);
    }
    const tenth = await createComment(10);
    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ?", [Date.UTC(2026, 8, 25, 18, 7)]);
    });

    // One comment on its own has nothing to line up with and prints no timestamp.
    expect(tenth.stdout).toBe("PAD-1#10 | Comment 10…\n");

    const timestamp = "2026-09-25 20:07 +02:00";
    // Later lines start under the text of the first line, after the padded key.
    const textIndent = " ".repeat(`PAD-1#10 | ${timestamp} | `.length);
    const listed = (await runZinn(["task", "comment", "list", "PAD-1"], testDir, { TZ: "Europe/Berlin" })).stdout;
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

    const viewed = (await runZinn(["task", "view", "PAD-1"], testDir, { TZ: "Europe/Berlin" })).stdout;
    expect(viewed).toContain(`\n\n${SECTION_RULE}\nComments:\n${listed}`);
  });
});

test("task comment commands validate their inputs without partial writes", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "NOTE"], testDir);
    await runZinn(["task", "create", "NOTE", "--title", "Commented task"], testDir);

    const cases = [
      [["task", "comment", "create", "NOTE-1"], { code: "invalid_input", details: { argument: "--text" } }],
      [["task", "comment", "create", "NOTE-1", "--text", "   "], { code: "invalid_input", details: { field: ["text"] } }],
      [["task", "comment", "create", "NOTE-1", "--text", "one", "--text", "two"], { code: "invalid_input", details: { argument: "--text" } }],
      [["task", "comment", "list"], { code: "invalid_input", details: { argument: "task-key" } }],
      [["task", "comment", "edit", "NOTE-1#1"], { code: "invalid_input", details: { argument: "--text" } }],
      [["task", "comment", "edit", "019dbfc3-f513-7000-8000-000000000000", "--text", "No"], { code: "invalid_input", details: { field: ["commentKey"] } }],
      [["task", "comment", "delete"], { code: "invalid_input", details: { argument: "comment-key" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn([...args, "--json"], testDir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
    }

    expect((await runZinn(["task", "comment", "list", "NOTE-1"], testDir)).stdout).toBe("");
  });
});

test("task move requires a task key and target column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["task", "move"], testDir)).stderr).toContain("Usage: zinn task move");
    expect((await runZinn(["task", "move", "MOVE-1"], testDir)).stderr).toContain("Usage: zinn task move");
  });
});

test("task move help identifies its command with either help flag", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const longHelp = await runZinn(["task", "move", "--help"], testDir);
    const shortHelp = await runZinn(["task", "move", "-h"], testDir);

    expect(longHelp.code).toBe(0);
    expect(longHelp.stderr).toBe("");
    expect(longHelp.stdout).toContain("Usage: zinn task move <task-key>... <target-column>");
    expect(shortHelp.code).toBe(0);
    expect(shortHelp.stdout).toBe(longHelp.stdout);
  });
});

test("task move rejects a column outside the task's project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ORIGIN", "--name", "Origin"], testDir);
    await runZinn(["project", "create", "OTHER", "--name", "Other"], testDir);
    await runZinn(["project", "column", "create", "OTHER", "External"], testDir);
    await runZinn(["task", "create", "ORIGIN", "--title", "stationary task"], testDir);

    const result = await runZinn(["--json", "task", "move", "ORIGIN-1", "External"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "column", key: "External" } });
    expect((await runZinn(["task", "view", "ORIGIN-1"], testDir)).stdout).toContain(
      `ORIGIN-1 | Backlog | - | stationary task`,
    );
  });
});

test("task move appends the task to the destination column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "MOVE", "--name", "Movable"], testDir);
    await runZinn(["task", "create", "MOVE", "--title", "first task"], testDir);
    await runZinn(["task", "create", "MOVE", "--title", "second task"], testDir);

    expect((await runZinn(["task", "move", "MOVE-1", "In Progress"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "move", "MOVE-2", "In Progress"], testDir)).code).toBe(0);

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

test("task move to the current column is a no-op", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "STILL", "--name", "Still"], testDir);
    await runZinn(["task", "create", "STILL", "--title", "still task"], testDir);

    const before = withTestDb(testDir, (db) =>
      db.query<{ column_id: string; task_order: string; updated_at: number }, []>(
        "SELECT column_id, task_order, updated_at FROM task WHERE title = 'still task'",
      ).get(),
    );

    const result = await runZinn(["task", "move", "STILL-1", "Backlog"], testDir);
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

test("task move takes several tasks, appends them in argument order, and notes no-ops", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "MANY"], testDir);
    for (const title of ["one", "two", "three"]) {
      await runZinn(["task", "create", "MANY", "--title", title], testDir);
    }
    await runZinn(["task", "move", "MANY-1", "In Progress"], testDir);

    const result = await runZinn(["task", "move", "MANY-3", "MANY-1", "MANY-2", "In Progress"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "MANY-3 | In Progress | - | three\nMANY-1 | In Progress | - | one\nMANY-2 | In Progress | - | two\n",
    );
    expect(result.stderr).toContain("MANY-1");
    expect(result.stderr).toContain("In Progress");
    expect((await runZinn(["task", "list", "MANY"], testDir)).stdout).toMatch(
      /^MANY-1[^\n]*\nMANY-3[^\n]*\nMANY-2[^\n]*\n$/,
    );
  });
});

test("task archive and unarchive take several tasks and note no-ops", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "SHELF"], testDir);
    for (const title of ["one", "two", "three"]) {
      await runZinn(["task", "create", "SHELF", "--title", title], testDir);
    }
    await runZinn(["task", "archive", "SHELF-2"], testDir);

    const archived = await runZinn(["task", "archive", "SHELF-1", "SHELF-2"], testDir);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toBe(
      "SHELF-1 | Archived | Backlog | - | one\nSHELF-2 | Archived | Backlog | - | two\n",
    );
    expect(archived.stderr).toContain("SHELF-2");

    const unarchived = await runZinn(["task", "unarchive", "SHELF-2", "SHELF-3", "SHELF-1"], testDir);
    expect(unarchived.code).toBe(0);
    expect(unarchived.stderr).toContain("SHELF-3");
    expect((await runZinn(["task", "list", "SHELF"], testDir)).stdout).toMatch(
      /^SHELF-3[^\n]*\nSHELF-2[^\n]*\nSHELF-1[^\n]*\n$/,
    );
  });
});

test("task move, archive and unarchive align several tasks and note repeated keys", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "A"], testDir);
    await runZinn(["project", "create", "LONG"], testDir);
    await runZinn(["task", "create", "A", "--title", "short key"], testDir);
    await runZinn(["task", "create", "LONG", "--title", "long key"], testDir);

    const moved = await runZinn(["task", "move", "A-1", "LONG-1", "A-1", "Done"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toBe(
      "A-1    | Done | - | short key\nLONG-1 | Done | - | long key\nA-1    | Done | - | short key\n",
    );
    expect(moved.stderr).toContain("A-1");
    expect(moved.stderr).toContain("Done");

    const archived = await runZinn(["task", "archive", "A-1", "LONG-1", "A-1"], testDir);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toBe(
      "A-1    | Archived | Done | - | short key\nLONG-1 | Archived | Done | - | long key\nA-1    | Archived | Done | - | short key\n",
    );
    expect(archived.stderr).toContain("A-1");

    const unarchived = await runZinn(["task", "unarchive", "LONG-1", "A-1", "LONG-1"], testDir);
    expect(unarchived.code).toBe(0);
    expect(unarchived.stdout).toBe(
      "LONG-1 | Active | Done | - | long key\nA-1    | Active | Done | - | short key\nLONG-1 | Active | Done | - | long key\n",
    );
    expect(unarchived.stderr).toContain("LONG-1");
  });
});

test("task move, archive and unarchive change nothing when any task fails", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ATOM"], testDir);
    await runZinn(["task", "create", "ATOM", "--title", "active"], testDir);
    await runZinn(["task", "create", "ATOM", "--title", "archived"], testDir);
    await runZinn(["task", "archive", "ATOM-2"], testDir);
    const before = (await runZinn(["task", "list", "ATOM", "--all", "--json"], testDir)).stdout;

    const move = await runZinn(["--json", "task", "move", "ATOM-1", "ATOM-2", "Done"], testDir);
    expect(move.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(move.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "archived", entity: "task", key: "ATOM-2" } });

    const archive = await runZinn(["--json", "task", "archive", "ATOM-1", "ATOM-404"], testDir);
    expect(archive.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(archive.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: "ATOM-404" } });

    const unarchive = await runZinn(["--json", "task", "unarchive", "ATOM-2", "nope"], testDir);
    expect(unarchive.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unarchive.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["taskKey"] } });

    expect((await runZinn(["task", "list", "ATOM", "--all", "--json"], testDir)).stdout).toBe(before);
  });
});

test("task move, archive and unarchive print an object for one task and an array for several with --json", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "SHAPE"], testDir);
    await runZinn(["task", "create", "SHAPE", "--title", "one"], testDir);
    await runZinn(["task", "create", "SHAPE", "--title", "two"], testDir);

    const moveOne = JSON.parse((await runZinn(["task", "move", "SHAPE-1", "Done", "--json"], testDir)).stdout);
    expect(moveOne).toMatchObject({ key: "SHAPE-1", column: "Done", changed: true });

    const moveUnchanged = JSON.parse(
      (await runZinn(["task", "move", "SHAPE-1", "Done", "--json"], testDir)).stdout,
    );
    expect(moveUnchanged).toMatchObject({ key: "SHAPE-1", column: "Done", changed: false });

    const archiveMany = JSON.parse(
      (await runZinn(["task", "archive", "SHAPE-1", "SHAPE-2", "SHAPE-1", "--json"], testDir)).stdout,
    );
    expect(archiveMany).toMatchObject([
      { key: "SHAPE-1", status: "Archived", changed: true },
      { key: "SHAPE-2", status: "Archived", changed: true },
      { key: "SHAPE-1", status: "Archived", changed: false },
    ]);

    const unarchiveOne = JSON.parse(
      (await runZinn(["task", "unarchive", "SHAPE-2", "--json"], testDir)).stdout,
    );
    expect(unarchiveOne).toMatchObject({ key: "SHAPE-2", status: "Active", changed: true });
  });
});

test("task move prints the task row, while --json returns the full task", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["label", "create", "urgent"], testDir);
    await runZinn(["project", "create", "BRIEF"], testDir);
    await runZinn(
      ["task", "create", "BRIEF", "--title", "Detailed task", "--description", "Hidden from move output", "--priority", "high", "--label", "urgent"],
      testDir,
    );

    const moved = await runZinn(["task", "move", "BRIEF-1", "In Progress"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toBe("BRIEF-1 | In Progress | H | Detailed task | urgent\n");
    expect((await runZinn(["task", "list", "BRIEF"], testDir)).stdout).toBe(moved.stdout);

    const movedJson = await runZinn(["task", "move", "BRIEF-1", "Review", "--json"], testDir);
    expect(movedJson.code).toBe(0);
    expect(JSON.parse(movedJson.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "BRIEF-1",
      status: "Active",
      column: "Review",
      title: "Detailed task",
      description: "Hidden from move output",
      priority: "high",
      labels: ["urgent"],
      label_ids: [expect.any(String)],
      changed: true,
    });
  });
});

test("task archive and unarchive print the same row with status for one task and for several", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["label", "create", "urgent"], testDir);
    await runZinn(["project", "create", "ROW"], testDir);
    await runZinn(["task", "create", "ROW", "--title", "one"], testDir);
    await runZinn(
      ["task", "create", "ROW", "--title", "two", "--description", "Not in rows", "--priority", "high", "--label", "urgent"],
      testDir,
    );

    const archivedOne = await runZinn(["task", "archive", "ROW-2"], testDir);
    expect(archivedOne.stdout).toBe("ROW-2 | Archived | Backlog | H | two | urgent\n");

    const unarchivedOne = await runZinn(["task", "unarchive", "ROW-2"], testDir);
    expect(unarchivedOne.stdout).toBe("ROW-2 | Active | Backlog | H | two | urgent\n");

    const archivedSeveral = await runZinn(["task", "archive", "ROW-1", "ROW-2"], testDir);
    expect(archivedSeveral.stdout).toBe(
      "ROW-1 | Archived | Backlog | - | one\nROW-2 | Archived | Backlog | H | two | urgent\n",
    );
    expect(archivedSeveral.stdout).toBe((await runZinn(["task", "list", "ROW", "--all"], testDir)).stdout);

    const unarchivedSeveral = await runZinn(["task", "unarchive", "ROW-1", "ROW-2"], testDir);
    expect(unarchivedSeveral.stdout).toBe(
      "ROW-1 | Active | Backlog | - | one\nROW-2 | Active | Backlog | H | two | urgent\n",
    );
    expect(unarchivedSeveral.stdout).toBe((await runZinn(["task", "list", "ROW", "--all"], testDir)).stdout);
  });
});

test("task move prints the same row for one task and for several, as task list shows it", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ROW"], testDir);
    await runZinn(["task", "create", "ROW", "--title", "one", "--priority", "low"], testDir);
    await runZinn(["task", "create", "ROW", "--title", "two"], testDir);

    const movedOne = await runZinn(["task", "move", "ROW-1", "Done"], testDir);
    expect(movedOne.stdout).toBe("ROW-1 | Done | L | one\n");

    const movedSeveral = await runZinn(["task", "move", "ROW-2", "ROW-1", "In Progress"], testDir);
    expect(movedSeveral.stdout).toBe("ROW-2 | In Progress | - | two\nROW-1 | In Progress | L | one\n");
    expect(movedSeveral.stdout).toBe((await runZinn(["task", "list", "ROW"], testDir)).stdout);
  });
});

test.serial("task delete prints the task row after Deleted, or after Deletion cancelled for when declined", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["label", "create", "urgent"], testDir);
    await runZinn(["project", "create", "ROW"], testDir);
    await runZinn(
      ["task", "create", "ROW", "--title", "one", "--description", "Not in rows", "--priority", "high", "--label", "urgent"],
      testDir,
    );
    const row = "ROW-1 | Backlog | H | one | urgent\n";

    const cancelled = await runCliInTerminal(["task", "delete", "ROW-1"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir, NO_COLOR: "1" },
      cwd: testDir,
      input: "n\n",
    });
    expect(cancelled.code).toBe(0);
    expect(cancelled.output).toContain(row.trimEnd());
    expect((await runZinn(["task", "list", "ROW"], testDir)).stdout).toBe(row);

    const deleted = await runZinn(["task", "delete", "ROW-1", "--yes"], testDir);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain(row.trimEnd());
    expect((await runZinn(["task", "list", "ROW"], testDir)).stdout).toBe("");
  });
});

test("project, column, label and comment edits distinguish no-ops from changes in text and JSON", async () => {
  for (const json of [false, true]) {
    await withIsolatedZinnDir(async (directory) => {
      const run = (...args: string[]) => runZinn(args, directory);
      expect((await run("project", "create", "EDIT", "--name", "App", "--description", "Alpha\nbeta")).code).toBe(0);
      expect((await run("label", "create", "bug", "--color", "red", "--description", "Alpha\nbeta")).code).toBe(0);
      expect((await run("task", "create", "EDIT", "--title", "Task", "--label", "bug")).code).toBe(0);
      expect((await run("task", "comment", "create", "EDIT-1", "--text", "Alpha\nbeta")).code).toBe(0);
      withTestDb(directory, (db) => {
        db.run("UPDATE project SET updated_at = 1");
        db.run("UPDATE task SET updated_at = 1");
        db.run("UPDATE comment SET updated_at = 1");
      });
      const snapshot = () => withTestDb(directory, (db) => ({
        projects: db.query("SELECT * FROM project ORDER BY id").all(),
        columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
        labels: db.query("SELECT * FROM label ORDER BY id").all(),
        tasks: db.query("SELECT * FROM task ORDER BY id").all(),
        comments: db.query("SELECT * FROM comment ORDER BY id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));
      const before = snapshot();
      const noOps = [
        { args: ["project", "edit", "edit", "--name", " App "], fact: "EDIT", expected: { key: "EDIT", name: "App" } },
        { args: ["project", "edit", "EDIT", "--description", "Alpha\r\nbeta"], fact: "EDIT", expected: { key: "EDIT", description: "Alpha\nbeta" } },
        { args: ["project", "edit", "EDIT", "--description", "Alpha", "--replacing", "Alpha"], fact: "EDIT", expected: { key: "EDIT" } },
        { args: ["project", "column", "edit", "EDIT", "backlog", "--name", " Backlog "], fact: "Backlog", expected: { project: "EDIT", name: "Backlog" } },
        { args: ["label", "edit", "BUG", "--name", " bug ", "--color", "red", "--description", "Alpha\r\nbeta"], fact: "bug", expected: { name: "bug", color: "red" } },
        { args: ["label", "edit", "bug", "--description", "Alpha", "--replacing", "Alpha"], fact: "bug", expected: { name: "bug" } },
        { args: ["task", "comment", "edit", "edit-1#1", "--text", "Alpha\r\nbeta"], fact: "EDIT-1#1", expected: { key: "EDIT-1#1", text: "Alpha\nbeta" } },
        { args: ["task", "comment", "edit", "EDIT-1#1", "--text", "Alpha", "--replacing", "Alpha"], fact: "EDIT-1#1", expected: { key: "EDIT-1#1" } },
      ];
      for (const { args, fact, expected } of noOps) {
        const result = await run(...args, ...(json ? ["--json"] : []));
        expect(result.code).toBe(0);
        expect(result.stderr).toContain(fact);
        expect(result.stderr.trim().split("\n")).toHaveLength(1);
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ ...expected, changed: false });
        } else {
          expect(result.stdout).toContain(fact);
        }
        expect(snapshot()).toEqual(before);
      }
      const edits = [
        { args: ["project", "edit", "EDIT", "--name", "Renamed", "--description", "Alpha\nbeta"], fact: "Renamed", expected: { key: "EDIT", name: "Renamed" } },
        { args: ["project", "column", "edit", "EDIT", "Backlog", "--name", "backlog"], fact: "backlog", expected: { project: "EDIT", name: "backlog" } },
        { args: ["label", "edit", "bug", "--color", "blue", "--description", "Alpha\nbeta"], fact: "bug", expected: { name: "bug", color: "blue" } },
        { args: ["task", "comment", "edit", "EDIT-1#1", "--text", "Edited"], fact: "EDIT-1#1", expected: { key: "EDIT-1#1", text: "Edited" } },
      ];
      for (const { args, fact, expected } of edits) {
        const result = await run(...args, ...(json ? ["--json"] : []));
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ ...expected, changed: true });
        } else {
          expect(result.stdout).toContain(fact);
        }
      }
      const after = snapshot();
      expect(after.tasks).toEqual(before.tasks);
      expect(after.activity.length).toBe(before.activity.length + edits.length);
    });
  }
});

test("task edits and label commands report no-ops and mixed changes in text and JSON", async () => {
  for (const json of [false, true]) {
    await withIsolatedZinnDir(async (directory) => {
      const run = (...args: string[]) => runZinn(args, directory);
      expect((await run("project", "create", "CHANGE")).code).toBe(0);
      for (const name of ["bug", "docs", "later"]) {
        expect((await run("label", "create", name)).code).toBe(0);
      }
      expect((await run("task", "create", "CHANGE", "--title", "First", "--description", "Details", "--label", "bug")).code).toBe(0);
      const snapshot = () => withTestDb(directory, (db) => ({
        tasks: db.query("SELECT * FROM task ORDER BY id").all(),
        labels: db.query("SELECT * FROM task_label ORDER BY task_id, label_id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));
      const noOps = [
        ["task", "edit", "change-1", "--title", " First "],
        ["task", "edit", "CHANGE-1", "--description", "Details"],
        ["task", "edit", "CHANGE-1", "--priority", "none"],
        ["task", "edit", "CHANGE-1", "--add-label", "BUG", "--remove-label", "docs"],
        ["task", "label", "add", "CHANGE-1", "BUG"],
        ["task", "label", "remove", "CHANGE-1", "docs"],
      ];
      for (const archived of [false, true]) {
        if (archived) {
          expect((await run("task", "archive", "CHANGE-1")).code).toBe(0);
        }
        const before = snapshot();
        for (const args of noOps) {
          const result = await run(...args, ...(json ? ["--json"] : []));
          expect(result.code).toBe(0);
          expect(result.stderr.trim().split("\n")).toHaveLength(1);
          expect(result.stderr).toContain("CHANGE-1");
          if (json) {
            expect(JSON.parse(result.stdout)).toMatchObject({ key: "CHANGE-1", title: "First", labels: ["bug"], changed: false });
          } else {
            expect(result.stdout).toContain("CHANGE-1");
            expect(result.stdout).toContain("First");
            expect(result.stdout).toContain("bug");
          }
          expect(snapshot()).toEqual(before);
        }
      }
      const changes = [
        { args: ["task", "edit", "CHANGE-1", "--title", "Renamed"], labels: ["bug"] },
        { args: ["task", "edit", "CHANGE-1", "--add-label", "bug", "--add-label", "docs"], labels: ["bug", "docs"] },
        { args: ["task", "label", "add", "CHANGE-1", "docs", "later"], labels: ["bug", "docs", "later"] },
        { args: ["task", "label", "remove", "CHANGE-1", "bug", "docs"], labels: ["later"] },
        { args: ["task", "label", "remove", "CHANGE-1", "bug", "later"], labels: [] },
      ];
      for (const { args, labels } of changes) {
        const result = await run(...args, ...(json ? ["--json"] : []));
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ key: "CHANGE-1", title: "Renamed", labels, changed: true });
        } else {
          expect(result.stdout).toContain("CHANGE-1");
          expect(result.stdout).toContain("Renamed");
          for (const name of labels) {
            expect(result.stdout).toContain(name);
          }
        }
      }
    });
  }
});

test("task write commands print JSON with the full task details, unchanged by the row output", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["label", "create", "urgent"], testDir);
    await runZinn(["project", "create", "ROW"], testDir);

    const created = await runZinn(
      ["task", "create", "ROW", "--title", "one", "--description", "Full text", "--priority", "high", "--label", "urgent", "--json"],
      testDir,
    );
    expect(JSON.parse(created.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "ROW-1",
      status: "Active",
      column: "Backlog",
      title: "one",
      description: "Full text",
      priority: "high",
      labels: ["urgent"],
      label_ids: [expect.any(String)],
    });

    const edited = await runZinn(["task", "edit", "ROW-1", "--title", "uno", "--json"], testDir);
    expect(JSON.parse(edited.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "ROW-1",
      status: "Active",
      column: "Backlog",
      title: "uno",
      description: "Full text",
      priority: "high",
      labels: ["urgent"],
      label_ids: [expect.any(String)],
      changed: true,
    });

    const archived = await runZinn(["task", "archive", "ROW-1", "--json"], testDir);
    expect(JSON.parse(archived.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "ROW-1",
      status: "Archived",
      column: "Backlog",
      title: "uno",
      description: "Full text",
      priority: "high",
      labels: ["urgent"],
      label_ids: [expect.any(String)],
      changed: true,
    });
  });
});

test("task move rejects archived tasks", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ARCHMOVE", "--name", "Archived move"], testDir);
    await runZinn(["task", "create", "ARCHMOVE", "--title", "archived task"], testDir);
    await runZinn(["task", "archive", "ARCHMOVE-1"], testDir);

    const before = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string; updated_at: number }, []>(
          "SELECT column_id, task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );

    const result = await runZinn(["--json", "task", "move", "ARCHMOVE-1", "In Progress"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "archived", key: "ARCHMOVE-1" } });

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

test("task order moves a task one position up or down within its column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ORDER", "--name", "Ordered"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "first task"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "second task"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "third task"], testDir);

    const movedUp = await runZinn(["task", "order", "ORDER-2", "up"], testDir);
    expect(movedUp.code).toBe(0);
    expect(movedUp.stderr).toBe("");
    expect((await runZinn(["task", "list", "ORDER"], testDir)).stdout).toMatch(
      /ORDER-2[^\n]*\nORDER-1[^\n]*\nORDER-3/,
    );

    const movedDown = await runZinn(["task", "order", "ORDER-2", "down"], testDir);
    expect(movedDown.code).toBe(0);
    expect(movedDown.stderr).toBe("");
    expect((await runZinn(["task", "list", "ORDER"], testDir)).stdout).toMatch(
      /ORDER-1[^\n]*\nORDER-2[^\n]*\nORDER-3/,
    );
  });
});

test("task order moves a task to the top or bottom of its column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EDGES", "--name", "Edges"], testDir);
    await runZinn(["task", "create", "EDGES", "--title", "first task"], testDir);
    await runZinn(["task", "create", "EDGES", "--title", "second task"], testDir);
    await runZinn(["task", "create", "EDGES", "--title", "third task"], testDir);

    expect((await runZinn(["task", "order", "EDGES-3", "top"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "EDGES"], testDir)).stdout).toMatch(
      /EDGES-3[^\n]*\nEDGES-1[^\n]*\nEDGES-2/,
    );

    expect((await runZinn(["task", "order", "EDGES-3", "bottom"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "EDGES"], testDir)).stdout).toMatch(
      /EDGES-1[^\n]*\nEDGES-2[^\n]*\nEDGES-3/,
    );
  });
});

test("task order places a task immediately before or after its target", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ANCHOR", "--name", "Anchored"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "first task"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "second task"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "third task"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "fourth task"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "fifth task"], testDir);

    expect((await runZinn(["task", "order", "ANCHOR-4", "before", "ANCHOR-2"], testDir)).code).toBe(
      0,
    );
    expect((await runZinn(["task", "list", "ANCHOR"], testDir)).stdout).toMatch(
      /ANCHOR-1[^\n]*\nANCHOR-4[^\n]*\nANCHOR-2[^\n]*\nANCHOR-3[^\n]*\nANCHOR-5/,
    );

    expect((await runZinn(["task", "order", "ANCHOR-4", "after", "ANCHOR-3"], testDir)).code).toBe(
      0,
    );
    expect((await runZinn(["task", "list", "ANCHOR"], testDir)).stdout).toMatch(
      /ANCHOR-1[^\n]*\nANCHOR-2[^\n]*\nANCHOR-3[^\n]*\nANCHOR-4[^\n]*\nANCHOR-5/,
    );
  });
});

test("task order requires a task key and an ordering instruction", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const missingTask = await runZinn(["task", "order"], testDir);
    expect(missingTask.code).toBe(1);
    expect(missingTask.stderr).toContain("Usage: zinn task order");

    const missingInstruction = await runZinn(["task", "order", "ORDER-1"], testDir);
    expect(missingInstruction.code).toBe(1);
    expect(missingInstruction.stderr).toContain("Usage: zinn task order");
  });
});

test("task order validates direction and target arguments", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const unknownDirection = await runZinn(["--json", "task", "order", "ORDER-1", "sideways"], testDir);
    expect(unknownDirection.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unknownDirection.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "direction" } });

    const missingTarget = await runZinn(["task", "order", "ORDER-1", "before"], testDir);
    expect(missingTarget.code).toBe(1);
    expect(missingTarget.stderr).toContain("Usage: zinn task order");

    const unexpectedTarget = await runZinn(["task", "order", "ORDER-1", "top", "ORDER-2"], testDir);
    expect(unexpectedTarget.code).toBe(1);
    expect(unexpectedTarget.stderr).toContain('"ORDER-2"');
    expect(unexpectedTarget.stderr).toContain("Usage: zinn task order");
  });
});

test("task order help documents its own command", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["task", "order", "--help"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: zinn task order");
    expect(result.stdout).toContain("top");
    expect(result.stdout).toContain("up");
    expect(result.stdout).toContain("down");
    expect(result.stdout).toContain("bottom");
    expect(result.stdout).toContain("before");
    expect(result.stdout).toContain("after");
  });
});

test("task order does not cross a column boundary", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "BOUND", "--name", "Bounded"], testDir);
    await runZinn(["task", "create", "BOUND", "--title", "backlog first"], testDir);
    await runZinn(["task", "create", "BOUND", "--title", "backlog last"], testDir);
    await runZinn(["task", "create", "BOUND", "--title", "progress first"], testDir);
    await runZinn(["task", "move", "BOUND-3", "In Progress"], testDir);

    withTestDb(testDir, (db) => {
      db.run("UPDATE task SET updated_at = 1 WHERE number IN (2, 3)");
    });

    expect((await runZinn(["task", "order", "BOUND-2", "down"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "order", "BOUND-3", "up"], testDir)).code).toBe(0);

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

test("task order rejects an unknown target task", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "TARGET", "--name", "Targeted"], testDir);
    await runZinn(["task", "create", "TARGET", "--title", "existing task"], testDir);

    const result = await runZinn(["--json", "task", "order", "TARGET-1", "before", "TARGET-99"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: "TARGET-99" } });
  });
});

test("task order rejects a target in another column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "SCOPE", "--name", "Scoped"], testDir);
    await runZinn(["task", "create", "SCOPE", "--title", "backlog task"], testDir);
    await runZinn(["task", "create", "SCOPE", "--title", "progress task"], testDir);
    await runZinn(["task", "move", "SCOPE-2", "In Progress"], testDir);

    const result = await runZinn(["--json", "task", "order", "SCOPE-1", "before", "SCOPE-2"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "different_column" } });
  });
});

test("task order targeting itself is a no-op", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "UNCHANGED", "--name", "Unchanged"], testDir);
    await runZinn(["task", "create", "UNCHANGED", "--title", "stationary task"], testDir);

    withTestDb(testDir, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));

    expect(
      (await runZinn(["task", "order", "UNCHANGED-1", "before", "UNCHANGED-1"], testDir)).code,
    ).toBe(0);

    const row = withTestDb(testDir, (db) =>
      db
        .query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1")
        .get(),
    );

    expect(row?.updated_at).toBe(1);
  });
});

test("task order leaves already-satisfied placements unchanged", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "SATISFIED", "--name", "Satisfied"], testDir);
    await runZinn(["task", "create", "SATISFIED", "--title", "first task"], testDir);
    await runZinn(["task", "create", "SATISFIED", "--title", "second task"], testDir);
    await runZinn(["task", "create", "SATISFIED", "--title", "third task"], testDir);

    withTestDb(testDir, (db) => db.run("UPDATE task SET updated_at = 1"));

    const read = () => withTestDb(testDir, (db) => ({
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    for (const json of [false, true]) {
      for (const [key, ...placement] of [
        ["SATISFIED-1", "top"], ["SATISFIED-1", "up"],
        ["SATISFIED-3", "bottom"], ["SATISFIED-3", "down"],
        ["SATISFIED-2", "before", "SATISFIED-3"], ["SATISFIED-2", "after", "SATISFIED-1"],
        ["SATISFIED-2", "before", "SATISFIED-2"], ["SATISFIED-2", "after", "SATISFIED-2"],
      ]) {
        const result = await runZinn(["task", "order", key!.toLowerCase(), ...placement, ...(json ? ["--json"] : [])], testDir);
        expect(result.code).toBe(0);
        expect(result.stderr).toContain(key!);
        expect(result.stderr.trim().split("\n")).toHaveLength(1);
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ key, changed: false });
        } else {
          expect(result.stdout).toContain(key!);
        }
        expect(read()).toEqual(before);
      }
    }

    const timestamps = withTestDb(testDir, (db) =>
      db.query<{ updated_at: number }, []>("SELECT updated_at FROM task ORDER BY number").all(),
    );
    expect(timestamps).toEqual([{ updated_at: 1 }, { updated_at: 1 }, { updated_at: 1 }]);
  });
});

test("task order rejects a target in another project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "FIRST", "--name", "First"], testDir);
    await runZinn(["project", "create", "SECOND", "--name", "Second"], testDir);
    await runZinn(["task", "create", "FIRST", "--title", "first project task"], testDir);
    await runZinn(["task", "create", "SECOND", "--title", "second project task"], testDir);

    const result = await runZinn(["--json", "task", "order", "FIRST-1", "before", "SECOND-1"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "different_project" } });
  });
});

test("task order rejects archived source and target tasks", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ARCHORDER", "--name", "Archived order"], testDir);
    await runZinn(["task", "create", "ARCHORDER", "--title", "active task"], testDir);
    await runZinn(["task", "create", "ARCHORDER", "--title", "archived task"], testDir);
    await runZinn(["task", "archive", "ARCHORDER-2"], testDir);

    const archivedSource = await runZinn(["--json", "task", "order", "ARCHORDER-2", "top"], testDir);
    expect(archivedSource.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(archivedSource.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "archived", key: "ARCHORDER-2" } });

    const archivedTarget = await runZinn(["--json", "task", "order", "ARCHORDER-1", "before", "ARCHORDER-2"], testDir);
    expect(archivedTarget.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(archivedTarget.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "archived", key: "ARCHORDER-2" } });
  });
});

test("task order uses visible active neighbours", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "VISIBLE", "--name", "Visible"], testDir);
    await runZinn(["task", "create", "VISIBLE", "--title", "first task"], testDir);
    await runZinn(["task", "create", "VISIBLE", "--title", "archived task"], testDir);
    await runZinn(["task", "create", "VISIBLE", "--title", "third task"], testDir);
    await runZinn(["task", "archive", "VISIBLE-2"], testDir);

    expect((await runZinn(["task", "order", "VISIBLE-1", "down"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "VISIBLE"], testDir)).stdout).toMatch(
      /VISIBLE-3[^\n]*\nVISIBLE-1/,
    );
  });
});

test("task archive hides a task from active lists without deleting it", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ARCH", "--name", "Archive"], testDir);
    await runZinn(["task", "create", "ARCH", "--title", "kept task", "--description", "kept description"], testDir);
    await runZinn(["task", "move", "ARCH-1", "In Progress"], testDir);

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

    expect((await runZinn(["task", "archive", "aRcH-1"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "ARCH"], testDir)).stdout).toBe("");
    expect((await runZinn(["task", "list", "ARCH", "--archived"], testDir)).stdout).toContain(
      "ARCH-1 | In Progress | - | kept task",
    );
    expect((await runZinn(["task", "list", "--all", "ARCH"], testDir)).stdout).toContain("kept task");
    expect((await runZinn(["task", "view", "ARCH-1"], testDir)).stdout).toContain("kept task");

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

test("task list --all identifies active and archived tasks in a status column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "MIXED", "--name", "Mixed archive"], testDir);
    await runZinn(["task", "create", "MIXED", "--title", "archived task"], testDir);
    await runZinn(["task", "create", "MIXED", "--title", "active task"], testDir);
    await runZinn(["task", "archive", "MIXED-1"], testDir);

    expect((await runZinn(["task", "list", "MIXED"], testDir)).stdout).toBe(
      `MIXED-2 | Backlog | - | active task\n`,
    );
    expect((await runZinn(["task", "list", "MIXED", "--archived"], testDir)).stdout).toBe(
      `MIXED-1 | Backlog | - | archived task\n`,
    );
    expect((await runZinn(["task", "list", "MIXED", "--all"], testDir)).stdout).toBe(
      [
        `MIXED-2 | Active   | Backlog | - | active task`,
        `MIXED-1 | Archived | Backlog | - | archived task`,
        "",
      ].join("\n"),
    );
  });
});

test("task unarchive appends the task after active tasks in its previous column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "RESTOREORDER", "--name", "Restore order"], testDir);
    await runZinn(["task", "create", "RESTOREORDER", "--title", "first task"], testDir);
    await runZinn(["task", "create", "RESTOREORDER", "--title", "second task"], testDir);
    await runZinn(["task", "create", "RESTOREORDER", "--title", "third task"], testDir);
    await runZinn(["task", "archive", "RESTOREORDER-1"], testDir);

    const archived = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string }, []>(
          "SELECT column_id, task_order FROM task WHERE number = 1",
        )
        .get(),
    )!;

    expect((await runZinn(["task", "unarchive", "RESTOREORDER-1"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "RESTOREORDER"], testDir)).stdout).toMatch(
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

test("task unarchive help identifies its command and arguments", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["task", "unarchive", "--help"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: zinn task unarchive <task-key>...");
  });
});

test("task archive is idempotent and unarchive restores active listing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "RESTORE", "--name", "Restore"], testDir);
    await runZinn(["task", "create", "RESTORE", "--title", "restorable task"], testDir);
    await runZinn(["task", "archive", "RESTORE-1"], testDir);

    withTestDb(testDir, (db) =>
      db.run("UPDATE task SET archived_at = 123, updated_at = 123 WHERE number = 1"),
    );
    expect((await runZinn(["task", "archive", "RESTORE-1"], testDir)).code).toBe(0);

    const stillArchived = withTestDb(testDir, (db) =>
      db
        .query<{ archived_at: number; updated_at: number }, []>(
          "SELECT archived_at, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );
    expect(stillArchived).toEqual({ archived_at: 123, updated_at: 123 });

    expect((await runZinn(["task", "unarchive", "RESTORE-1"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "RESTORE"], testDir)).stdout).toContain("restorable task");
    expect((await runZinn(["task", "list", "RESTORE", "--archived"], testDir)).stdout).toBe("");

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

    expect((await runZinn(["task", "unarchive", "RESTORE-1"], testDir)).code).toBe(0);

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

test("task archive and unarchive require a valid existing task key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["task", "archive"], testDir)).stderr).toContain("Usage: zinn task archive");
    expect((await runZinn(["task", "unarchive"], testDir)).stderr).toContain("Usage: zinn task unarchive");
    expect(errorDocumentSchema.parse(JSON.parse((await runZinn(["--json", "task", "archive", "INVALID"], testDir)).stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("INVALID"), details: { field: ["taskKey"] } });
    expect(errorDocumentSchema.parse(JSON.parse((await runZinn(["--json", "task", "unarchive", "NOPE-1"], testDir)).stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOPE" } });
  });
});

test("project list shows every established project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "LIST", "--name", "Listed"], testDir);

    const result = await runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("LIST");
  });
});

test("task delete removes the task but not its project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    await runZinn(["task", "create", "KEEP", "--title", "doomed task"], testDir);

    expect((await runZinn(["task", "delete", "KEEP-1", "--yes"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "KEEP"], testDir)).stdout).not.toContain("doomed task");
    expect((await runZinn(["project", "list"], testDir)).stdout).toContain("KEEP");
  });
});

test.serial("task delete keeps the task when confirmation is declined", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    await runZinn(["task", "create", "KEEP", "--title", "surviving task"], testDir);

    const declined = await runCliInTerminal(["task", "delete", "KEEP-1"], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir }, cwd: testDir, input: "n\n" });
    expect(declined.code).toBe(0);
    expect((await runZinn(["task", "list", "KEEP"], testDir)).stdout).toContain("surviving task");
  });
});

test("task delete requires a valid existing task key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["task", "delete"], testDir)).stderr).toContain("Usage: zinn task delete");
    expect(errorDocumentSchema.parse(JSON.parse((await runZinn(["--json", "task", "delete", "INVALID"], testDir)).stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("INVALID"), details: { field: ["taskKey"] } });
  });
});

test("task edit preserves omitted fields and identity, and accepts empty descriptions", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    await runZinn(["task", "create", "EDIT", "--title", "Original", "--description", "Description"], dir);
    const read = () => withTestDb(dir, (db) =>
      db.query<import("../core/src/types").Task, []>("SELECT * FROM task").get()!);
    withTestDb(dir, (db) => db.run("UPDATE task SET updated_at = 1"));
    const before = read();
    expect((await runZinn(["task", "edit", "edit-1", "--title", "New title"], dir)).code).toBe(0);
    const after = read();
    expect(after).toEqual({ ...before, title: "New title", updated_at: after.updated_at });
    expect(after.updated_at).toBeGreaterThan(1);
    expect((await runZinn(["task", "edit", "EDIT-1", "--description", ""], dir)).code).toBe(0);
    expect(read().description).toBeNull();
    expect(read().title).toBe("New title");
    withTestDb(dir, (db) => db.run("UPDATE task SET updated_at = 1"));
    expect((await runZinn(["task", "edit", "EDIT-1", "--title", "New title", "--description", ""], dir)).code).toBe(0);
    expect(read().updated_at).toBe(1);
    expect((await runZinn(["task", "edit", "--description=Changed", "EDIT-1", "--title=--example"], dir)).code).toBe(0);
    expect(read()).toMatchObject({ title: "--example", description: "Changed" });
  });
});

test("task edit rejects invalid requests without partial writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    await runZinn(["task", "create", "EDIT", "--title", "Original", "--description", "Description"], dir);
    const usage = "Usage: zinn task edit";
    const cases = [
      [[], { code: "invalid_input", details: { argument: "task-key" }, help: expect.stringContaining(usage) }],
      [["EDIT-1"], { code: "invalid_input" }],
      [["EDIT-1", "--title"], { code: "invalid_input", details: { argument: "--title" } }],
      [["EDIT-1", "--description"], { code: "invalid_input", details: { argument: "--description" } }],
      [["EDIT-1", "--unknown", "text"], { code: "invalid_input", details: { argument: "--unknown" } }],
      [["EDIT-1", "extra", "--title", "text"], { code: "invalid_input", message: expect.stringContaining("extra"), details: { field: [] }, help: expect.stringContaining(usage) }],
      [["EDIT-1", "--title", "one", "--title", "two"], { code: "invalid_input", details: { argument: "--title" } }],
      [["EDIT-1", "--title", ""], { code: "invalid_input", details: { field: ["title"] } }],
      [["EDIT-1", "--title", "   "], { code: "invalid_input", details: { field: ["title"] } }],
      [["EDIT-1", "--title", "", "--description", "Changed"], { code: "invalid_input", details: { field: ["title"] } }],
      [["INVALID", "--title", "text"], { code: "invalid_input", details: { field: ["taskKey"] } }],
      [["EDIT-99", "--title", "text"], { code: "not_found", details: { entity: "task", key: "EDIT-99" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn(["task", "edit", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
    }
    expect(taskViewContent((await runZinn(["task", "view", "EDIT-1"], dir)).stdout)).toBe(
      `EDIT-1 | Backlog | - | Original\n\n${SECTION_RULE}\nDescription:\nDescription\n`,
    );
  });
});

test("task edit preserves archive state and documents its flags", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await withIsolatedZinnDir(async (dir) => {
      await runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
      await runZinn(["task", "create", "EDIT", "--title", "Original"], dir);
      await runZinn(["task", "archive", "EDIT-1"], dir);
      expect((await runZinn(["task", "edit", "EDIT-1", "--title", "Archived edit"], dir)).code).toBe(0);
      expect((await runZinn(["task", "list", "EDIT"], dir)).stdout).toBe("");
      expect((await runZinn(["task", "list", "EDIT", "--archived"], dir)).stdout).toContain("Archived edit");
    });
    const help = await runZinn(["task", "edit", "--help"], testDir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--description ''");
  });
});

test("project mutations print the affected entity", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "life", "--name", "Responsive"], testDir)).stdout).toBe(
      "LIFE | Responsive\n",
    );
    expect((await runZinn(["project", "delete", "life", "--yes"], testDir)).stdout).toContain(
      "Deleted LIFE | Responsive\n",
    );
  });
});

test.serial("task mutations print the resulting entity", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "LIFE", "--name", "Responsive"], testDir);

    expect((await runZinn(["task", "create", "LIFE", "--title", "First", "--description", "Description"], testDir)).stdout).toBe(
      `LIFE-1 | Backlog | - | First\n`,
    );
    await runZinn(["task", "create", "LIFE", "--title", "Second"], testDir);
    expect(
      (await runZinn(["task", "edit", "life-1", "--title", "Updated"], testDir)).stdout,
    ).toBe(`LIFE-1 | Backlog | - | Updated\n`);
    expect((await runZinn(["task", "move", "LIFE-1", "TODO"], testDir)).stdout).toBe(
      "LIFE-1 | TODO | - | Updated\n",
    );
    await runZinn(["task", "move", "LIFE-2", "TODO"], testDir);
    expect((await runZinn(["task", "order", "LIFE-2", "top"], testDir)).stdout).toBe(
      "LIFE-2 | TODO | - | Second\n",
    );
    expect((await runZinn(["task", "archive", "LIFE-1"], testDir)).stdout).toBe(
      "LIFE-1 | Archived | TODO | - | Updated\n",
    );
    expect((await runZinn(["task", "unarchive", "LIFE-1"], testDir)).stdout).toBe(
      "LIFE-1 | Active | TODO | - | Updated\n",
    );
    expect((await runZinn(["task", "delete", "LIFE-1", "--yes"], testDir)).stdout).toContain(
      "Deleted LIFE-1 | TODO | - | Updated",
    );
    const declined = await runCliInTerminal(["task", "delete", "LIFE-2"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir, NO_COLOR: "1" },
      cwd: testDir,
      input: "n\n",
    });
    expect(declined.output).toContain("LIFE-2 | TODO | - | Second");
  });
});

// ? Empty strings pass the routers' `== null` guards; core's validation rejects them.
test("empty-string arguments are rejected", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTY", "--name", "Empty"], testDir);

    const blankTitle = await runZinn(["--json", "task", "create", "EMPTY", "--title", ""], testDir);
    expect(blankTitle.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(blankTitle.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["title"] } });

    const blankProject = await runZinn(["--json", "project", "create", "", "--name", ""], testDir);
    expect(blankProject.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(blankProject.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["key"] } });
  });
});

// --- TASK SEARCH

test("task search prints matches in task list rows and JSON shape", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    await run("project", "create", "FIND");
    await run("task", "create", "FIND", "--title", "Refine the numbers", "--description", "Quarterly quota", "--priority", "high");
    await run("task", "create", "FIND", "--title", "Unrelated");
    await run("task", "comment", "create", "FIND-2", "--text", "Blocked on refinement tools");

    const result = await run("task", "search", "REFIN");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        `FIND-1 | Backlog | H | Refine the numbers`,
        `FIND-2 | Backlog | - | Unrelated`,
        "",
      ].join("\n"),
    );

    const listed = JSON.parse((await run("task", "list", "FIND", "--json")).stdout);
    const searched = JSON.parse((await run("task", "search", "refine quota", "--json")).stdout);
    expect(searched).toEqual([listed[0]]);
  });
});

test("task search finds a description-only match and prints its plain task row", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    const description = "Quarterly refinement checklist";
    await run("project", "create", "SEEK");
    await run("label", "create", "ops");
    await run("task", "create", "SEEK", "--title", "Calibrate sensors", "--description", description, "--label", "ops");
    await run("task", "create", "SEEK", "--title", "Unrelated");

    const result = await run("task", "search", "checklist");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("SEEK-1 | Backlog | - | Calibrate sensors | ops\n");

    expect(JSON.parse((await run("task", "search", "checklist", "--json")).stdout)).toEqual([
      expect.objectContaining({ key: "SEEK-1", description, labels: ["ops"] }),
    ]);
  });
});

test("task search with no matches exits zero without output", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EMPTY"], dir);
    await runZinn(["task", "create", "EMPTY", "--title", "Something"], dir);

    expect(await runZinn(["task", "search", "nothing"], dir)).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(await runZinn(["task", "search", "nothing", "--json"], dir)).toEqual({
      stdout: "[]\n",
      stderr: "",
      code: 0,
    });
  });
});

test("task search treats FTS syntax as text and accepts a leading dash after --", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SYN"], dir);
    await runZinn(["task", "create", "SYN", "--title", "Fix sign-in (again)", "--description", "AND NOT"], dir);

    for (const query of ["-", '"', ":", "(", "AND", "NOT", "*", 'sign-in "', "NEAR(a b)"]) {
      const result = await runZinn(["task", "search", "--", query], dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }

    expect((await runZinn(["task", "search", "--", "-sign"], dir)).stdout).toContain("SYN-1");
    expect((await runZinn(["task", "search", "(again) and not"], dir)).stdout).toContain("SYN-1");
  });
});

test("task search treats --json and --help after -- as literal query text, not router flags", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "ESC"], dir);
    await runZinn(["task", "create", "ESC", "--title", "Something"], dir);

    // Neither literal query matches any task; JSON mode would print "[]\n"
    // and a help request would print usage text, so empty output on both
    // stdout and stderr confirms "--json"/"--help" were searched for, not acted on.
    expect(await runZinn(["task", "search", "--", "--json"], dir)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
    expect(await runZinn(["task", "search", "--", "--help"], dir)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
  });
});

test("task search pins an exact task key before text matches", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "PIN"], dir);
    await runZinn(["task", "create", "PIN", "--title", "Mentions pin-2 first"], dir);
    await runZinn(["task", "create", "PIN", "--title", "The pinned task"], dir);

    const keys = JSON.parse((await runZinn(["task", "search", "pin-2", "--json"], dir)).stdout).map(
      (entry: { key: string }) => entry.key,
    );
    expect(keys).toEqual(["PIN-2", "PIN-1"]);
  });
});

test("task search hides archived matches with a stderr hint and filters by project and limit", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    await run("project", "create", "ONE");
    await run("project", "create", "TWO");
    await run("task", "create", "ONE", "--title", "Widget active");
    await run("task", "create", "ONE", "--title", "Widget archived");
    await run("task", "create", "ONE", "--title", "Widget also archived");
    await run("task", "create", "TWO", "--title", "Widget elsewhere");
    await run("task", "archive", "ONE-2");
    await run("task", "archive", "ONE-3");

    const active = await run("task", "search", "widget", "one");
    expect(active.code).toBe(0);
    expect(active.stdout).toBe(`ONE-1 | Backlog | - | Widget active\n`);
    expect(active.stderr).toContain("2");
    expect(active.stderr).toContain("--all");

    const activeJson = await run("task", "search", "widget", "ONE", "--json");
    expect(JSON.parse(activeJson.stdout)).toHaveLength(1);
    expect(activeJson.stdout).not.toContain("hidden");
    expect(activeJson.stderr).toContain("2");
    expect(activeJson.stderr).toContain("--all");

    const single = await run("task", "search", "ONE-2", "ONE");
    expect(single.stdout).toBe("");
    expect(single.stderr).toContain("1");
    expect(single.stderr).toContain("--all");

    const archived = await run("task", "search", "widget", "ONE", "--archived");
    expect(archived.stderr).toBe("");
    expect(archived.stdout.trimEnd().split("\n").sort()).toEqual([
      `ONE-2 | Backlog | - | Widget archived`,
      `ONE-3 | Backlog | - | Widget also archived`,
    ]);

    const all = await run("task", "search", "widget", "--all");
    expect(all.stderr).toBe("");
    expect(all.stdout.trimEnd().split("\n")).toHaveLength(4);
    expect(all.stdout).toContain(`ONE-2 | Archived | Backlog | - | Widget archived`);
    expect(all.stdout).toContain(`TWO-1 | Active   | Backlog | - | Widget elsewhere`);

    expect((await run("task", "search", "widget", "--all", "--limit", "3")).stdout.trimEnd().split("\n")).toHaveLength(3);
    expect((await run("task", "search", "widget", "TWO")).stdout).toBe(`TWO-1 | Backlog | - | Widget elsewhere\n`);
  });
});

test("task search validates its arguments", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "VAL"], dir);

    const usage = "Usage: zinn task search";
    const cases = [
      [[], { code: "invalid_input", details: { argument: "query" }, help: expect.stringContaining(usage) }],
      [[""], { code: "invalid_input", details: { field: ["query"] } }],
      [["a", "VAL", "extra"], { code: "invalid_input", message: expect.stringContaining("extra"), details: { field: [] }, help: expect.stringContaining(usage) }],
      [["a", "--archived", "--all"], { code: "invalid_input", details: { argument: "--archived" } }],
      [["a", "--limit", "0"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "two"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "0x5"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "1e1"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", " 5 "], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "5."], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "1", "--limit", "2"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "MISSING"], { code: "not_found", details: { entity: "project", key: "MISSING" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn(["task", "search", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
    }
  });
});

// --- NOT YET TESTABLE

// ? Do not assert merely that stdout is JSON-parseable: `console.info` renders
// ? a flat string array as `[ "Backlog", ... ]`, which parses by coincidence.
// ? Assert the entity shape instead.
test("--json emits machine-readable output on read commands", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "JSON", "--name", "Json"], testDir);

    const result = await runZinn(["project", "column", "list", "JSON", "--json"], testDir);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toBeArray();
    expect(parsed[0]).toMatchObject({ name: "Backlog" });
  });
});

test("--json prints the created entity on write commands, wherever the flag is placed", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const project = await runZinn(["project", "create", "--json", "WEB", "--name", "Web"], testDir);
    expect(JSON.parse(project.stdout)).toEqual({ id: expect.any(String), key: "WEB", name: "Web", description: null });

    const created = await runZinn(["task", "create", "WEB", "--title", "Ship it", "--json"], testDir);

    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "WEB-1",
      status: "Active",
      column: "Backlog",
      title: "Ship it",
      description: null,
      priority: null,
      labels: [],
      label_ids: [],
    });
  });
});

test("--json combines a task and its relations into one document on task view", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "WEB"], testDir);
    await runZinn(["task", "create", "WEB", "--title", "API"], testDir);
    await runZinn(["task", "create", "WEB", "--title", "UI"], testDir);
    await runZinn(["task", "relation", "create", "WEB-2", "WEB-1", "--type", "dependency"], testDir);

    const viewed = JSON.parse((await runZinn(["task", "view", "WEB-2", "--json"], testDir)).stdout);

    expect(viewed).toMatchObject({ key: "WEB-2", title: "UI" });
    expect(viewed.relations).toEqual([
      {
        id: expect.any(String),
        type: "dependency",
        direction: "outgoing",
        task: { id: expect.any(String), project_id: expect.any(String), column_id: expect.any(String), key: "WEB-1", column: "Backlog", title: "API", status: "Active" },
      },
    ]);
  });
});

test("--json prints an empty array for empty lists, while text output stays empty", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "list"], testDir)).stdout).toBe("");
    expect(JSON.parse((await runZinn(["project", "list", "--json"], testDir)).stdout)).toEqual([]);
    expect(JSON.parse((await runZinn(["label", "list", "--json"], testDir)).stdout)).toEqual([]);
  });
});

test("--json reports errors as JSON on stderr and leaves stdout empty", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["project", "create", "--json"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const parsed = JSON.parse(result.stderr);
    expect(Object.keys(parsed)).toEqual(["error"]);
    expect(errorDocumentSchema.safeParse(parsed).success).toBe(true);
    expect(parsed.error.code).toBe("invalid_input");
    expect(parsed.error.details.argument).toBe("project-key");
    expect(parsed.error.message).toContain("<project-key>");
    expect(parsed.error.help).toContain("Usage: zinn project create");
  });
});

// ? A database with something for each confirming command to change. Returns a backup taken before "Later" was added.
async function seedConfirmationDatabase(dir: string) {
  await runZinn(["project", "create", "CONF"], dir);
  await runZinn(["label", "create", "bug"], dir);
  await runZinn(["task", "create", "CONF", "--title", "Kept", "--label", "bug"], dir);
  await runZinn(["task", "comment", "create", "CONF-1", "--text", "Note"], dir);
  const backupPath = (JSON.parse((await runZinn(["backup", "--json"], dir)).stdout) as { path: string }).path;
  await runZinn(["task", "create", "CONF", "--title", "Later"], dir);

  return backupPath;
}

function confirmationSnapshot(dir: string) {
  const tables = withTestDb(dir, (db) =>
    ["project", "task", "comment", "label", "task_label", "activity"].map((table) =>
      db.query(`SELECT * FROM ${table}`).all(),
    ),
  );

  return { tables, backups: backupFiles(dir) };
}

const runJson = async (dir: string, ...args: Array<string>) => JSON.parse((await runZinn([...args, "--json"], dir)).stdout);

// ? ZINN-143: every command that asks for confirmation, run against seedConfirmationDatabase,
// ? with a check that its change happened.
const CONFIRMING_COMMANDS = [
  {
    argsFor: (_backupPath: string) => ["project", "column", "delete", "CONF", "Review"],
    isDone: async (dir: string) => !(await runJson(dir, "project", "column", "list", "CONF"))
      .some((entry: { name: string }) => entry.name === "Review"),
  },
  {
    argsFor: (_backupPath: string) => ["project", "delete", "CONF"],
    isDone: async (dir: string) => (await runJson(dir, "project", "list")).length === 0,
  },
  {
    argsFor: (_backupPath: string) => ["task", "delete", "CONF-1"],
    isDone: async (dir: string) => (await runZinn(["task", "view", "CONF-1"], dir)).code === 1,
  },
  {
    argsFor: (_backupPath: string) => ["task", "comment", "delete", "CONF-1#1"],
    isDone: async (dir: string) => (await runJson(dir, "task", "view", "CONF-1")).comments.length === 0,
  },
  {
    argsFor: (_backupPath: string) => ["label", "delete", "bug"],
    isDone: async (dir: string) => (await runJson(dir, "label", "list")).length === 0,
  },
  {
    argsFor: (backupPath: string) => ["restore", backupPath],
    isDone: async (dir: string) => (await runJson(dir, "task", "list", "CONF")).length === 1,
  },
];

test("confirming commands without --yes refuse when not in a terminal, and --yes still performs them", async () => {
  for (const { argsFor, isDone } of CONFIRMING_COMMANDS) {
    await withIsolatedZinnDir(async (dir) => {
      const args = argsFor(await seedConfirmationDatabase(dir));
      const before = confirmationSnapshot(dir);

      for (const refused of [await runZinn(args, dir), await runZinnWithPipedYes(args, dir)]) {
        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toContain("--yes");
        expect(confirmationSnapshot(dir)).toEqual(before);
      }

      const jsonRefused = await runZinn([...args, "--json"], dir);
      expect(jsonRefused.code).toBe(1);
      expect(jsonRefused.stdout).toBe("");
      expect(JSON.parse(jsonRefused.stderr).error.message).toContain("--yes");
      expect(confirmationSnapshot(dir)).toEqual(before);

      const confirmed = await runZinn([...args, "--yes"], dir);
      expect(confirmed.code).toBe(0);
      expect(await isDone(dir)).toBe(true);
    });
  }
});

test.serial("confirming commands in a terminal act on y and cancel on n with exit code 0", async () => {
  for (const { argsFor, isDone } of CONFIRMING_COMMANDS) {
    await withIsolatedZinnDir(async (dir) => {
      const args = argsFor(await seedConfirmationDatabase(dir));
      const env = { ...TEST_ENVIRONMENT, ZINN_DIR: dir };
      const before = confirmationSnapshot(dir);

      for (const input of ["n\n", "\n"]) {
        const declined = await runCliInTerminal(args, { env, cwd: dir, input });
        expect(declined.code).toBe(0);
        expect(confirmationSnapshot(dir)).toEqual(before);
      }

      const accepted = await runCliInTerminal(args, { env, cwd: dir, input: "y\n" });
      expect(accepted.code).toBe(0);
      expect(await isDone(dir)).toBe(true);
    });
  }
});

test.serial("confirmation prompts use stderr, preserve exact affirmative answers, and decline EOF", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedConfirmationDatabase(dir);
    const before = confirmationSnapshot(dir);
    const stderrPath = join(dir, "prompt.stderr");
    const options = { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir, stderrPath };

    for (const input of ["yes\n", " y \n", "\x04"]) {
      const result = await runCliInTerminal(["task", "delete", "CONF-1"], { ...options, input });
      expect(result.code).toBe(0);
      expect(result.output).not.toContain("[y/N]");
      const stderr = readFileSync(stderrPath, "utf8");
      expect(stderr).toContain("CONF-1");
      expect(stderr).toContain("[y/N]");
      expect(stderr).toEndWith("\n");
      expect(confirmationSnapshot(dir)).toEqual(before);
    }

    const accepted = await runCliInTerminal(["task", "delete", "CONF-1"], { ...options, input: "Y\n" });
    expect(accepted.code).toBe(0);
    expect(accepted.output).not.toContain("[y/N]");
    expect((await runZinn(["task", "view", "CONF-1"], dir)).code).toBe(1);
  });
});

test.serial("interrupting a confirmation exits 130 and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedConfirmationDatabase(dir);
    const before = confirmationSnapshot(dir);
    const result = await runCliInTerminal(["task", "delete", "CONF-1"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir, input: "\x03", inputWhen: "[y/N]",
    });
    expect(result.code).toBe(130);
    expect(confirmationSnapshot(dir)).toEqual(before);
  });
});

test("--json refuses commands that ask for confirmation without --yes, deleting nothing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "WEB"], testDir);

    const result = await runZinnWithPipedYes(["project", "delete", "WEB", "--json"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({
      code: "invalid_input", details: { argument: "--yes", reason: "confirmation_required" },
    });
    expect((await runZinn(["project", "list"], testDir)).stdout).toBe("WEB | WEB | 0 active | 0 archived\n");
  });
});

test("--yes deletes without asking for confirmation", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "WEB"], testDir);
    await runZinn(["task", "create", "WEB", "--title", "Ship it"], testDir);

    const result = await runZinn(["task", "delete", "WEB-1", "--yes"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("WEB-1 | Backlog | - | Ship it");
    expect((await runZinn(["task", "list", "WEB"], testDir)).stdout).toBe("");
  });
});

test("delete commands with --yes and --json print the deleted entity", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const deleteJson = async (...args: Array<string>) => {
      const result = await run(...args, "--yes", "--json");
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout);
    };

    await run("project", "create", "WEB", "--name", "Web");
    await run("project", "create", "GONE", "--name", "Gone");
    await run("task", "create", "WEB", "--title", "Ship it");
    await run("task", "create", "WEB", "--title", "Keep it");
    await run("task", "comment", "create", "WEB-2", "--text", "Looks good");
    await run("label", "create", "urgent", "--color", "red", "--description", "Needs attention soon");

    expect(await deleteJson("task", "delete", "WEB-1")).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "WEB-1",
      status: "Active",
      column: "Backlog",
      title: "Ship it",
      description: null,
      priority: null,
      labels: [],
      label_ids: [],
    });
    expect(JSON.parse((await run("task", "list", "WEB", "--json")).stdout)).toMatchObject([
      { key: "WEB-2" },
    ]);

    const deletedComment = await deleteJson("task", "comment", "delete", "WEB-2#1");
    expect(deletedComment).toEqual({
      id: expect.any(String),
      task_id: expect.any(String),
      key: "WEB-2#1",
      text: "Looks good",
      created_at: deletedComment.created_at,
      updated_at: deletedComment.updated_at,
    });
    expect(JSON.parse((await run("task", "comment", "list", "WEB-2", "--json")).stdout)).toEqual([]);

    expect(await deleteJson("label", "delete", "urgent")).toEqual({
      id: expect.any(String),
      name: "urgent",
      color: "red",
      description: "Needs attention soon",
    });
    expect(JSON.parse((await run("label", "list", "--json")).stdout)).toEqual([]);

    expect(await deleteJson("project", "delete", "GONE")).toEqual({ id: expect.any(String), key: "GONE", name: "Gone", description: null });
    expect(JSON.parse((await run("project", "list", "--json")).stdout)).toEqual([
      { id: expect.any(String), key: "WEB", name: "Web", description: null, taskCounts: { active: 1, archived: 0 } },
    ]);
  });
});

test("project edit renames without changing identity, tasks, columns, or archive state", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EDIT", "--name", "Original"], dir);
    await runZinn(["task", "create", "EDIT", "--title", "Keep task"], dir);
    const read = () => withTestDb(dir, (db) => ({
      project: db.query<import("../core/src/types").Project, []>("SELECT * FROM project").get()!,
      tasks: db.query("SELECT * FROM task").all(),
      columns: db.query("SELECT * FROM project_column").all(),
    }));
    withTestDb(dir, (db) => db.run("UPDATE project SET updated_at = 1, archived_at = 2"));
    const before = read();
    const result = await runZinn(["project", "edit", "edit", "--name", "New name"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("EDIT | New name\n");
    expect(result.stderr).toBe("");
    const after = read();
    expect(after).toEqual({ ...before, project: {
      ...before.project, name: "New name", updated_at: after.project.updated_at,
    } });
    expect(after.project.updated_at).toBeGreaterThan(1);
    withTestDb(dir, (db) => db.run("UPDATE project SET updated_at = 1"));
    expect((await runZinn(["project", "edit", "EDIT", "--name", "New name"], dir)).code).toBe(0);
    expect(read().project.updated_at).toBe(1);
    expect((await runZinn(["project", "edit", "--name=--example", "EDIT"], dir)).code).toBe(0);
    expect((await runZinn(["project", "list"], dir)).stdout).toContain("EDIT | --example");
  });
});

test("project edit rejects invalid requests without writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EDIT", "--name", "Original"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project").get());
    const before = read();
    const usage = "Usage: zinn project edit";
    const cases = [
      [[], { code: "invalid_input", details: { argument: "project-key" }, help: expect.stringContaining(usage) }],
      [["EDIT"], { code: "invalid_input" }],
      [["EDIT", "--name"], { code: "invalid_input", details: { argument: "--name" } }],
      [["EDIT", "--key", "NEW"], { code: "invalid_input", details: { argument: "--key" } }],
      [["EDIT", "extra", "--name", "Name"], { code: "invalid_input", message: expect.stringContaining("extra"), details: { field: [] }, help: expect.stringContaining(usage) }],
      [["EDIT", "--name", "One", "--name", "Two"], { code: "invalid_input", details: { argument: "--name" } }],
      [["EDIT", "--name", ""], { code: "invalid_input", details: { field: ["name"] } }],
      [["EDIT", "--name", "   "], { code: "invalid_input", details: { field: ["name"] } }],
      [["EDIT", "--name", "Two\nlines"], { code: "invalid_input", details: { field: ["name"] } }],
      [["MISSING", "--name", "Name"], { code: "not_found", details: { entity: "project", key: "MISSING" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn(["project", "edit", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
      expect(read()).toEqual(before);
    }
  });
});

// --- RELATIONS

test("relation commands show directional and symmetric links, including archived cross-project tasks", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("project", "create", "OTHER")).code).toBe(0);
    await run("task", "create", "APP", "--title", "Copy");
    await run("task", "create", "OTHER", "--title", "Original");
    expect((await run("task", "relation", "list", "APP-1")).stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "relation", "create", "APP-1", "APP-1", "--type", "related")).stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["targetTaskKey"] } });
    expect((await run("task", "relation", "create", "APP-1", "OTHER-99", "--type", "related")).code).toBe(1);
    expect((await run("task", "relation", "list", "OTHER-99")).code).toBe(1);
    for (const type of relationTypeSchema.options) {
      const created = await run("task", "relation", "create", "app-1", "OTHER-1", "--type", type);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain("APP-1");
      expect(created.stdout).toContain("OTHER-1");
      const outgoing = JSON.parse((await run("task", "relation", "list", "APP-1", "--json")).stdout);
      const incoming = JSON.parse((await run("task", "relation", "list", "OTHER-1", "--json")).stdout);
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]).toMatchObject({ type, direction: type === "related" ? null : "outgoing", task: { key: "OTHER-1", title: "Original" } });
      expect(incoming).toHaveLength(1);
      expect(incoming[0]).toMatchObject({ type, direction: type === "related" ? null : "incoming", task: { key: "APP-1", title: "Copy" } });
      if (type === "related") {
        expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "relation", "create", "OTHER-1", "APP-1", "--type", "related")).stderr)).error).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "relation" } });
      }
      expect((await run("task", "relation", "delete", "APP-1", "OTHER-1", "--type", type)).code).toBe(0);
    }
    expect((await run("task", "relation", "create", "APP-1", "OTHER-1", "--type", "subtask")).code).toBe(0);
    await run("task", "archive", "OTHER-1");
    expect((await run("task", "view", "APP-1")).stdout).toMatch(/Parent\s+\| OTHER-1 \| Backlog \| Original \| Archived/);
    const viewed = JSON.parse((await run("task", "view", "APP-1", "--json")).stdout);
    expect(viewed.relations).toContainEqual({
      id: expect.any(String),
      type: "subtask", direction: "outgoing",
      task: { id: expect.any(String), project_id: expect.any(String), column_id: expect.any(String), key: "OTHER-1", column: "Backlog", title: "Original", status: "Archived" },
    });
    expect((await run("task", "create", "APP", "--title", "Child", "--parent", "APP-1")).code).toBe(0);
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "relation", "create", "OTHER-1", "APP-2", "--type", "subtask")).stderr)).error).toMatchObject({ code: "conflict", details: { reason: "cycle" } });
    expect((await run("task", "relation", "delete", "APP-1", "OTHER-1", "--type", "subtask")).code).toBe(0);
    expect((await run("task", "view", "APP-1")).stdout).not.toContain("Parent");
    expect((await run("task", "relation", "create", "OTHER-1", "APP-1", "--type", "dependency")).code).toBe(0);
  });
});

test("relation list aligns and colors connected columns, and marks archived tasks", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("project", "create", "APP");
    await run("project", "create", "LONGER");
    await run("task", "create", "APP", "--title", "Copy");
    await run("task", "create", "APP", "--title", "Plan");
    await run("task", "create", "APP", "--title", "Review");
    await run("task", "create", "LONGER", "--title", "Original");
    await run("task", "move", "LONGER-1", "Done");
    expect((await run("project", "column", "create", "APP", "Verification")).code).toBe(0);
    expect((await run("task", "move", "APP-3", "Verification")).code).toBe(0);
    await run("task", "archive", "APP-2");
    await run("task", "relation", "create", "APP-1", "LONGER-1", "--type", "dependency");
    await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    await run("task", "relation", "create", "APP-3", "APP-1", "--type", "dependency");

    const expectedLines = [
      "Depends on     | LONGER-1 | Done         | Original",
      "Related to     | APP-2    | Backlog      | Plan | Archived",
      "Depended on by | APP-3    | Verification | Review",
    ];
    const listed = (await run("task", "relation", "list", "APP-1")).stdout;
    expect(listed.trimEnd().split("\n")).toEqual(expectedLines);
    const colored = (await runZinn(["task", "relation", "list", "APP-1"], dir, { FORCE_COLOR: "1" })).stdout;
    expect(colored).toContain("\x1b[32mDone        \x1b[39m");
    expect(colored).toContain("\x1b[90mBacklog     \x1b[39m");
    expect(colored).toContain(`${DIM_SEPARATOR}Verification${DIM_SEPARATOR}`);
    expect((await runZinn(["task", "relation", "list", "APP-1"], dir, { NO_COLOR: "1" })).stdout).toBe(listed);
    const json = JSON.parse((await run("task", "relation", "list", "APP-1", "--json")).stdout);
    expect(json.find((entry: { task: { key: string } }) => entry.task.key === "LONGER-1").task.column).toBe("Done");
    expect(json.map((entry: { task: { key: string } }) => entry.task.key)).toEqual(["LONGER-1", "APP-2", "APP-3"]);
    const viewedJson = JSON.parse((await run("task", "view", "APP-1", "--json")).stdout);
    expect(viewedJson.relations).toEqual(json);

    const viewed = (await run("task", "view", "APP-1")).stdout;
    expect(viewed).toContain(`\n\n${SECTION_RULE}\nRelations:\n`);
    expect(viewed).toContain(`${expectedLines.join("\n")}\n`);
  });
});

test("relation help and argument errors make types discoverable without prompting", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    for (const args of [
      ["APP-1", "APP-2"],
      ["APP-1", "APP-2", "--type", "unknown"],
    ]) {
      const result = await runZinn(["task", "relation", "create", ...args], testDir);
      expect(result.code).toBe(1);
      for (const type of relationTypeSchema.options) {
        expect(result.stderr).toContain(type);
      }
    }
    for (const args of [
      ["APP-1", "--type", "related"],
      ["APP-1", "APP-2", "APP-3", "--type", "related"],
      ["APP-1", "APP-2", "--type", "related", "--type", "duplicate"],
      ["APP-1", "APP-2", "--typo", "related"],
    ]) {
      expect((await runZinn(["task", "relation", "create", ...args], testDir)).code).toBe(1);
    }
    const help = await runZinn(["task", "relation", "create", "--help"], testDir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: zinn task relation create");
    expect(help.stdout).toContain("--type");
    for (const type of relationTypeSchema.options) {
      expect(help.stdout).toContain(type);
    }
    expect((await runZinn(["task", "relation", "--help"], testDir)).stdout).toContain("Usage: zinn task relation <command>");
    expect((await runZinn(["task", "relation", "list"], testDir)).code).toBe(1);
    expect((await runZinn(["task", "relation", "list", "APP-1", "APP-2"], testDir)).code).toBe(1);
  });
});

test("relation deletion is usable without a prompt and updates list and view", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "First");
    await run("task", "create", "APP", "--title", "Second");
    await run("task", "create", "APP", "--title", "Third");
    await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    await run("task", "relation", "create", "APP-1", "APP-3", "--type", "dependency");
    const removed = await run("task", "relation", "delete", "app-2", "APP-1", "--type", "related");
    expect(removed.code).toBe(0);
    for (const fact of ["related", "APP-2", "APP-1"]) {
      expect(removed.stdout).toContain(fact);
    }
    expect((await run("task", "relation", "list", "APP-1")).stdout).toContain("Depends on");
    expect((await run("task", "view", "APP-2")).stdout).not.toContain("Related to");
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "relation", "delete", "APP-1", "APP-2", "--type", "related")).stderr)).error).toMatchObject({ code: "not_found", details: { entity: "relation" } });
    for (const args of [[], ["APP-1"], ["APP-1", "APP-2"],
      ["APP-1", "APP-2", "--type", "invalid"],
      ["APP-1", "APP-2", "--type", "related", "--type", "dependency"],
    ]) {
      expect((await run("task", "relation", "delete", ...args)).code).toBe(1);
    }
    expect((await run("task", "relation", "delete", "--help")).stdout).toContain("Usage: zinn task relation delete");
    expect((await run("task", "relation", "--help")).stdout).toContain("Usage: zinn task relation <command>");
  });
});

test("global label workflows support repeated create/edit flags and preserve task content", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect((await run("project", "create", "APP")).code).toBe(0);
    for (const name of ["bug", "auth", "needs review, soon"]) {
      expect((await run("label", "create", name, "--color", "red", "--description", "Details")).code).toBe(0);
    }
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "create", "BUG")).stderr)).error).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "label", key: "BUG" } });
    expect((await run("label", "create", "invalid", "--color", "purple")).code).toBe(1);
    expect((await run("label", "list")).stdout).toContain(`${"bug".padEnd("needs review, soon".length)} | red | Details`);
    const created = await run("task", "create", "APP", "--title", "Login", "--description", "", "--label", "BUG", "--label", "AUTH");
    expect(created.code).toBe(0);
    expect(created.stdout).toBe("APP-1 | Backlog | - | Login | auth, bug\n");
    const editedLabel = await run("label", "edit", " BUG ", "--name", " defect ", "--color", "blue", "--description", "");
    expect(editedLabel.code).toBe(0);
    expect(editedLabel.stdout).toBe("defect | blue\n");
    expect(taskViewContent((await run("task", "view", "APP-1")).stdout)).toBe("APP-1 | Backlog | - | Login | auth, defect\n");
    expect(JSON.parse((await run("label", "edit", "defect", "--description", "Fixed", "--json")).stdout)).toEqual({
      id: expect.any(String),
      name: "defect",
      color: "blue",
      description: "Fixed",
      changed: true,
    });
    expect((await run("task", "edit", "APP-1", "--title", "Changed", "--add-label", "NEEDS REVIEW, SOON", "--add-label", "AUTH", "--remove-label", "DEFECT")).code).toBe(0);
    expect(taskViewContent((await run("task", "view", "APP-1")).stdout)).toBe(
      "APP-1 | Backlog | - | Changed | auth, needs review, soon\n",
    );
    expect((await run("task", "edit", "APP-1", "--title", "Must not change", "--add-label", "unknown")).code).toBe(1);
    expect((await run("task", "view", "APP-1")).stdout).toContain("Changed");
    expect((await run("task", "edit", "APP-1", "--add-label", "BUG", "--remove-label", "bug")).code).toBe(1);
    expect((await run("task", "label", "add", "APP-1", "DEFECT")).stdout).toBe(
      "APP-1 | Backlog | - | Changed | auth, defect, needs review, soon\n",
    );
    expect((await run("task", "label", "remove", "APP-1", "AUTH", "dEfEcT")).stdout).toBe(
      "APP-1 | Backlog | - | Changed | needs review, soon\n",
    );
    expect((await runZinn(["label", "delete", "NEEDS REVIEW, SOON", "--yes"], dir)).code).toBe(0);
    expect(taskViewContent((await run("task", "view", "APP-1")).stdout)).toBe("APP-1 | Backlog | - | Changed\n");
    expect((await run("label", "list")).stdout).toContain("auth");
    for (const args of [
      ["APP", "Old positional title"],
      ["APP", "--title", "One", "--title", "Two"],
      ["APP", "--title", "One", "--description", "A", "--description", "B"],
      ["APP", "--title", "One", "--unknown", "x"],
      ["APP", "--title", "One", "--label", "missing"],
    ]) {
      expect((await run("task", "create", ...args)).code).toBe(1);
    }
    expect((await run("task", "create", "APP", "--title=--example")).stdout).toContain("APP-2");
  });
});

test.serial("label text output colors the name in a terminal and names the color when piped, while JSON keeps the color value", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);

    expect((await run("label", "create", "bug", "--color", "red", "--description", "Broken")).stdout).toBe(
      "bug | red | Broken\n",
    );
    expect((await run("label", "create", "later")).stdout).toBe("later | white\n");

    const createdInTerminal = await runZinnInTerminal(["label", "create", "chore", "--color", "gray"], dir);
    expect(createdInTerminal.code).toBe(0);
    expect(createdInTerminal.output).toBe("\x1b[90mchore\x1b[39m\n");

    const listed = (await run("label", "list")).stdout;
    expect(listed).not.toContain("\x1b[");
    for (const line of ["bug   | red   | Broken", "chore | gray", "later | white"]) {
      expect(listed).toContain(`${line}\n`);
    }
    const listedInTerminal = (await runZinnInTerminal(["label", "list"], dir)).output;
    expect(listedInTerminal).toContain(`\x1b[31mbug  \x1b[39m${DIM_SEPARATOR}Broken\n`);
    for (const colorName of ["red", "white", "gray"]) {
      expect(listedInTerminal).not.toContain(colorName);
    }

    const created = (await run("label", "create", "docs", "--color", "cyan", "--json")).stdout;
    expect(created).not.toContain("\x1b[");
    expect(JSON.parse(created)).toEqual({ id: expect.any(String), name: "docs", color: "cyan", description: null });

    const listedJson = (await run("label", "list", "--json")).stdout;
    expect(listedJson).not.toContain("\x1b[");
    expect(JSON.parse(listedJson)).toContainEqual({ id: expect.any(String), name: "bug", color: "red", description: "Broken" });
  });
});

test("label create, edit and list preview descriptions while view and JSON retain the full text", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    const description = `${"x".repeat(100)}\nFull description`;
    const preview = `${"x".repeat(79)}…`;
    const created = await run("label", "create", "bug", "--description", description);
    expect(created.code).toBe(0);
    expect(created.stderr).toBe("");
    expect(created.stdout).toEndWith(` | ${preview}\n`);

    const edited = await run("label", "edit", "bug", "--description", `First line\n${description}`);
    expect(edited.code).toBe(0);
    expect(edited.stderr).toBe("");
    expect(edited.stdout).toEndWith(" | First line…\n");
    const listed = await run("label", "list");
    expect(listed.code).toBe(0);
    expect(listed.stderr).toBe("");
    expect(listed.stdout).toEndWith(" | First line…\n");
    expect(listed.stdout).not.toContain(description);
    expect((await run("label", "view", "bug")).stdout).toContain(`First line\n${description}`);

    for (const args of [["label", "create", "docs"], ["label", "edit", "bug"]]) {
      const result = await run(...args, "--description", description, "--json");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        id: expect.any(String),
        name: args[2], color: "white", description,
        ...(args[1] === "edit" ? { changed: true } : {}),
      });
    }

    const labels = await run("label", "list", "--json");
    expect(labels.code).toBe(0);
    expect(labels.stderr).toBe("");
    expect(JSON.parse(labels.stdout)).toEqual([
      { id: expect.any(String), name: "bug", color: "white", description },
      { id: expect.any(String), name: "docs", color: "white", description },
    ]);
    const listedLongDescriptions = await run("label", "list");
    expect(listedLongDescriptions.code).toBe(0);
    expect(listedLongDescriptions.stdout.trimEnd().split("\n")).toHaveLength(2);
    for (const line of listedLongDescriptions.stdout.trimEnd().split("\n")) {
      expect(line).toEndWith(` | ${preview}`);
    }
  });
});

test("label view preserves full descriptions and reads one case-insensitive name without writes", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    const description = "  First line\n\tSecond line\n" + "Full description. ".repeat(20) + "\n";
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("label", "create", "Needs Review", "--color", "red", "--description", description)).code).toBe(0);
    expect((await run("label", "create", "Empty")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Attached", "--label", "Needs Review")).code).toBe(0);
    const snapshot = () => withTestDb(directory, (db) => ({
      labels: db.query("SELECT * FROM label ORDER BY id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      attachments: db.query("SELECT * FROM task_label ORDER BY task_id, label_id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = snapshot();
    for (const env of [{ FORCE_COLOR: "0" }, { FORCE_COLOR: "1" }]) {
      const viewed = await runZinn(["label", "view", " needs REVIEW "], directory, env);
      expect(viewed.code).toBe(0);
      expect(viewed.stderr).toBe("");
      expect(viewed.stdout).toContain("Needs Review");
      expect(viewed.stdout).toContain(description);
      expect(viewed.stdout).not.toContain("Empty");
      const viewedJson = await runZinn(["label", "view", "NEEDS review", "--json"], directory, env);
      expect(viewedJson.code).toBe(0);
      expect(viewedJson.stderr).toBe("");
      expect(JSON.parse(viewedJson.stdout)).toEqual({ id: expect.any(String), name: "Needs Review", color: "red", description });
      const empty = await runZinn(["label", "view", "empty", "--json"], directory, env);
      expect(empty.code).toBe(0);
      expect(JSON.parse(empty.stdout)).toEqual({ id: expect.any(String), name: "Empty", color: "white", description: null });
      const listed = await runZinn(["label", "list"], directory, env);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("First line…");
      expect(listed.stdout).not.toContain("Second line");
    }
    expect((await run("label", "view", "Empty")).stdout).toBe("Empty | white\n");
    expect(snapshot()).toEqual(before);
  });
});

test("label view rejects invalid arguments and missing labels with structured errors", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("label", "create", "bug")).code).toBe(0);
    const cases = [
      { args: ["missing"], error: { code: "not_found", details: { entity: "label", key: "missing", source: "explicit" } } },
      { args: [" "], error: { code: "invalid_input", details: { field: ["name"] } } },
      { args: ["bad\nname"], error: { code: "invalid_input", details: { field: ["name"] } } },
      { args: [], error: { code: "invalid_input" } },
      { args: ["bug", "extra"], error: { code: "invalid_input" } },
      { args: ["bug", "--unknown"], error: { code: "invalid_input" } },
    ];
    for (const { args, error } of cases) {
      const result = await run("label", "view", ...args, "--json");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(error);
    }
    const missing = await run("label", "view", "missing");
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("missing");
  });
});

test("label list pads names and color words so descriptions line up, with no cell for a missing description", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("label", "create", "bug", "--color", "red", "--description", "Broken");
    await run("label", "create", "chore", "--color", "magenta");
    await run("label", "create", "documentation", "--color", "gray", "--description", "Docs");

    // The color word of the label without a description ends its row, and still sets the column's width.
    expect((await run("label", "list")).stdout).toBe(
      [
        "bug           | red     | Broken",
        "chore         | magenta",
        "documentation | gray    | Docs",
        "",
      ].join("\n"),
    );

    // A single label has nothing to line up with.
    expect((await run("label", "edit", "documentation", "--description", "Guides")).stdout).toBe(
      "documentation | gray | Guides\n",
    );
  });
});

test.serial("label list pads a colored name by its plain text, so color codes do not shift the descriptions", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);
    await runZinn(["label", "create", "chore", "--color", "gray"], dir);
    await runZinn(["label", "create", "documentation", "--color", "blue", "--description", "Docs"], dir);

    // The name of a label without a description ends its row, so it is not padded.
    const expected =
      [
        `\x1b[31m${"bug".padEnd("documentation".length)}\x1b[39m${DIM_SEPARATOR}Broken`,
        "\x1b[90mchore\x1b[39m",
        `\x1b[34mdocumentation\x1b[39m${DIM_SEPARATOR}Docs`,
        "",
      ].join("\n");

    expect((await runZinnInTerminal(["label", "list"], dir)).output).toBe(expected);
    expect((await runZinn(["label", "list"], dir, { FORCE_COLOR: "1" })).stdout).toBe(expected);
  });
});

test.serial("NO_COLOR turns color off in a terminal, so text output reads as it does when piped", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "PLAIN"], dir);
    await runZinn(["task", "create", "PLAIN", "--title", "waiting"], dir);
    await runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);

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

test.serial("FORCE_COLOR colors piped output and wins over NO_COLOR, while FORCE_COLOR=0 turns color off", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "FORCE"], dir);
    await runZinn(["task", "create", "FORCE", "--title", "waiting"], dir);
    await runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);

    const coloredLabel = `\x1b[31mbug\x1b[39m${DIM_SEPARATOR}Broken\n`;
    expect((await runZinn(["task", "list", "FORCE"], dir, { FORCE_COLOR: "1" })).stdout).toBe(
      `FORCE-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}waiting\n`,
    );
    expect((await runZinn(["label", "list"], dir, { FORCE_COLOR: "1", NO_COLOR: "1" })).stdout).toBe(coloredLabel);

    // Any non-empty value other than 0 forces color; an empty FORCE_COLOR counts as unset.
    expect((await runZinn(["label", "list"], dir, { FORCE_COLOR: "true" })).stdout).toBe(coloredLabel);
    expect((await runZinn(["label", "list"], dir, { FORCE_COLOR: "" })).stdout).toBe("bug | red | Broken\n");
    expect((await runZinnInTerminal(["label", "list"], dir, { FORCE_COLOR: "0" })).output).toBe(
      "bug | red | Broken\n",
    );
  });
});

test.serial("Zinn's color policy controls rendering even when Node's environment rules differ", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    const environments = [
      { values: { FORCE_COLOR: "banana" }, pipeHasColor: true },
      { values: { FORCE_COLOR: "banana", NO_COLOR: "1" }, pipeHasColor: true },
      { values: { NODE_DISABLE_COLORS: "1" }, pipeHasColor: false },
      { values: { TERM: "dumb" }, pipeHasColor: false },
    ];

    for (const { values, pipeHasColor } of environments) {
      const env = { FORCE_COLOR: "", NO_COLOR: "", NODE_DISABLE_COLORS: "", TERM: "xterm-256color", ...values };
      const piped = await runZinn(["label", "list"], dir, env);
      expect(piped.code).toBe(0);
      expect(piped.stdout.includes("\x1b[31m")).toBe(pipeHasColor);
      expect(piped.stdout.includes("red")).toBe(!pipeHasColor);

      const terminal = await runZinnInTerminal(["label", "list"], dir, env);
      expect(terminal.code).toBe(0);
      expect(terminal.output).toContain("\x1b[31mbug\x1b[39m");
      expect(terminal.output).not.toContain("red");

      const json = await runZinn(["label", "list", "--json"], dir, env);
      expect(json.code).toBe(0);
      expect(json.stdout).not.toContain("\x1b");
      expect(JSON.parse(json.stdout)).toEqual([{ id: expect.any(String), name: "bug", color: "red", description: null }]);
    }
  });
});

test.serial("task rows color each attached label name by its label color, with dimmed separators and unchanged column widths", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    await runZinn(["label", "create", "cli", "--color", "blue"], dir);
    await runZinn(["label", "create", "docs", "--color", "cyan"], dir);
    await runZinn(["project", "create", "TAGS", "--name", "Task labels"], dir);
    await runZinn(
      ["task", "create", "TAGS", "--title", "Several labels", "--priority", "urgent", "--label", "docs", "--label", "bug", "--label", "cli"],
      dir,
    );
    await runZinn(["task", "create", "TAGS", "--title", "No labels"], dir);
    await runZinn(["task", "move", "TAGS-2", "Done"], dir);

    // Labels are listed by name, and only the names are colored: the ", " joins stay plain, and the " | " before them is dimmed like the others.
    const coloredLabels = "\x1b[31mbug\x1b[39m, \x1b[34mcli\x1b[39m, \x1b[36mdocs\x1b[39m";
    const coloredRows = [
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}U${DIM_SEPARATOR}Several labels${DIM_SEPARATOR}${coloredLabels}`,
      `TAGS-2${DIM_SEPARATOR}\x1b[32m${"Done".padEnd("Backlog".length)}\x1b[39m${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}No labels`,
      "",
    ].join("\n");

    expect((await runZinnInTerminal(["task", "list", "TAGS"], dir)).output).toBe(coloredRows);
    expect((await runZinn(["task", "list", "TAGS"], dir, { FORCE_COLOR: "1" })).stdout).toBe(coloredRows);
    expect((await runZinn(["task", "search", "Several", "TAGS"], dir, { FORCE_COLOR: "1" })).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}U${DIM_SEPARATOR}Several labels${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect((await runZinn(["task", "list", "TAGS", "--all"], dir, { FORCE_COLOR: "1" })).stdout).toContain(
      `TAGS-1${DIM_SEPARATOR}Active${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}U${DIM_SEPARATOR}Several labels${DIM_SEPARATOR}${coloredLabels}\n`,
    );

    // A label's color applies to every task that has the label.
    await runZinn(["label", "edit", "bug", "--color", "yellow"], dir);
    expect((await runZinn(["task", "list", "TAGS"], dir, { FORCE_COLOR: "1" })).stdout).toContain(
      "\x1b[33mbug\x1b[39m, \x1b[34mcli\x1b[39m",
    );
  });
});

test.serial("label names in task write rows and in task view are colored by their label color", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    await runZinn(["label", "create", "docs", "--color", "cyan"], dir);
    await runZinn(["project", "create", "TAGS"], dir);

    const forceColor = { FORCE_COLOR: "1" };
    const coloredLabels = "\x1b[31mbug\x1b[39m, \x1b[36mdocs\x1b[39m";

    expect(
      (await runZinn(["task", "create", "TAGS", "--title", "Tagged", "--label", "docs", "--label", "bug"], dir, forceColor)).stdout,
    ).toBe(`TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`);
    expect(taskViewContent((await runZinn(["task", "view", "TAGS-1"], dir, forceColor)).stdout)).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect(taskViewContent((await runZinnInTerminal(["task", "view", "TAGS-1"], dir)).output)).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect((await runZinn(["task", "label", "remove", "TAGS-1", "bug"], dir, forceColor)).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}\x1b[36mdocs\x1b[39m\n`,
    );
    expect((await runZinn(["task", "label", "add", "TAGS-1", "bug"], dir, forceColor)).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect(
      (await runZinn(["task", "edit", "TAGS-1", "--title", "Retitled"], dir, forceColor)).stdout,
    ).toBe(`TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Retitled${DIM_SEPARATOR}${coloredLabels}\n`);
  });
});

test("task rows dim the separators and the empty priority marker, whether or not the task has a priority or labels", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    await runZinn(["project", "create", "DIM"], dir);
    await runZinn(["task", "create", "DIM", "--title", "Both", "--priority", "high", "--label", "bug"], dir);
    await runZinn(["task", "create", "DIM", "--title", "Priority only", "--priority", "low"], dir);
    await runZinn(["task", "create", "DIM", "--title", "Labels only", "--label", "bug"], dir);
    await runZinn(["task", "create", "DIM", "--title", "Neither"], dir);

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

    expect((await runZinn(["task", "list", "DIM"], dir, forceColor)).stdout).toBe(dimmedRows);
    expect((await runZinn(["task", "list", "DIM"], dir)).stdout).toBe(plainRows);
    expect((await runZinn(["task", "list", "DIM"], dir, { NO_COLOR: "1" })).stdout).toBe(plainRows);
    expect(taskViewContent((await runZinn(["task", "view", "DIM-3"], dir, forceColor)).stdout)).toBe(
      dimmedRows.split("\n")[2] + "\n",
    );
    expect(taskViewContent((await runZinn(["task", "view", "DIM-3"], dir)).stdout)).toBe("DIM-3 | Backlog | - | Labels only | bug\n");
  });
});

test("task view bolds its section headings and dims the separators and comment timestamps, and reads plain when piped", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (env: Record<string, string>, ...args: Array<string>) =>
      runZinn(args, dir, { TZ: "Europe/Berlin", ...env });
    await run({}, "project", "create", "MDR");
    await run({}, "label", "create", "bug", "--color", "red");
    await run({}, "label", "create", "cli", "--color", "blue");
    await run({}, "task", "create", "MDR", "--title", "Refine the numbers", "--description", "First line.\nSecond line.", "--priority", "high", "--label", "cli", "--label", "bug");
    await run({}, "task", "create", "MDR", "--title", "Check the totals");
    await run({}, "task", "relation", "create", "MDR-1", "MDR-2", "--type", "dependency");
    await run({}, "task", "comment", "create", "MDR-1", "--text", "Ready for review");
    await run({}, "task", "comment", "create", "MDR-1", "--text", "Line one\nLine two");
    withTestDb(dir, (db) => {
      db.run("UPDATE comment SET created_at = ?, updated_at = ? WHERE number = 1", [Date.UTC(2026, 8, 25, 17, 42), Date.UTC(2026, 8, 25, 17, 42)]);
      db.run("UPDATE comment SET created_at = ?, updated_at = ? WHERE number = 2", [Date.UTC(2026, 8, 25, 18, 7), Date.UTC(2026, 8, 25, 18, 7)]);
    });

    // Later lines of a comment start under its text, so the indent counts the plain widths of the cells before it.
    const textIndent = " ".repeat("MDR-1#1 | 2026-09-25 19:42 +02:00 | ".length);
    const colored = await run({ FORCE_COLOR: "1" }, "task", "view", "MDR-1");

    expect(colored.stderr).toBe("");
    expect(taskViewContent(colored.stdout)).toBe(
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
    expect(taskViewContent((await run({}, "task", "view", "MDR-1")).stdout)).toBe(piped);
    expect(taskViewContent((await run({ NO_COLOR: "1" }, "task", "view", "MDR-1")).stdout)).toBe(piped);
    expect((await run({ FORCE_COLOR: "1" }, "task", "view", "MDR-1", "--json")).stdout).not.toContain("\x1b");
  });
});

test("project view bolds its section headings, dims the separators and colors column names as task rows do, and project list dims the separator before a preview", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (env: Record<string, string>, ...args: Array<string>) => runZinn(args, dir, env);
    await run({}, "project", "create", "MDR", "--name", "Macrodata", "--description", "First line.\nSecond line.");
    await run({}, "task", "create", "MDR", "--title", "Waiting");
    await run({}, "task", "create", "MDR", "--title", "Finished");
    await run({}, "task", "create", "MDR", "--title", "Shelved");
    await run({}, "task", "move", "MDR-2", "Done");
    await run({}, "task", "archive", "MDR-3");

    // Column names are padded inside their color codes, to the plain width of the widest name.
    const columnWidth = "In Progress".length;
    expect((await run({ FORCE_COLOR: "1" }, "project", "view", "MDR")).stdout).toBe(
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
    expect((await run({ FORCE_COLOR: "1" }, "project", "list")).stdout).toBe(
      `MDR${DIM_SEPARATOR}Macrodata${DIM_SEPARATOR}2 active${DIM_SEPARATOR}1 archived${DIM_SEPARATOR}First line. Second line.\n`,
    );

    expect((await run({}, "project", "view", "MDR")).stdout).toBe(
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
    expect((await run({}, "project", "list")).stdout).toBe("MDR | Macrodata | 2 active | 1 archived | First line. Second line.\n");
    expect((await run({ FORCE_COLOR: "1" }, "project", "view", "MDR", "--json")).stdout).not.toContain("\x1b");
    const columnEnvironments: Array<Record<string, string>> = [{}, { FORCE_COLOR: "1" }, { NO_COLOR: "1" }];
    for (const env of columnEnvironments) {
      const projectView = (await run(env, "project", "view", "MDR")).stdout;
      const columnList = (await run(env, "project", "column", "list", "MDR")).stdout;
      const columnsSection = projectView.split(env.FORCE_COLOR ? bold("Columns:") : "Columns:")[1]!;
      expect(columnsSection.trimStart()).toStartWith(columnList);
      expect(columnList).not.toContain("Archived");
    }
  });
});

test("comment lists dim the separators and timestamps, while a single comment has no timestamp to dim", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "NOTE"], dir);
    await runZinn(["task", "create", "NOTE", "--title", "Commented task"], dir);
    await runZinn(["task", "comment", "create", "NOTE-1", "--text", "First comment"], dir);
    await runZinn(["task", "comment", "create", "NOTE-1", "--text", "Second comment"], dir);
    withTestDb(dir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 1", [Date.UTC(2026, 8, 24, 9, 5)]);
      db.run("UPDATE comment SET created_at = ? WHERE number = 2", [Date.UTC(2026, 8, 25, 17, 42)]);
    });

    const env = { TZ: "Europe/Berlin" };
    const colored = await runZinn(["task", "comment", "list", "NOTE-1"], dir, { ...env, FORCE_COLOR: "1" });
    expect(colored.stdout).toBe(
      [
        `NOTE-1#1${DIM_SEPARATOR}${dim("2026-09-24 11:05 +02:00")}${DIM_SEPARATOR}First comment`,
        `NOTE-1#2${DIM_SEPARATOR}${dim("2026-09-25 19:42 +02:00")}${DIM_SEPARATOR}Second comment`,
        "",
      ].join("\n"),
    );
    expect((await runZinn(["task", "comment", "list", "NOTE-1"], dir, env)).stdout).toBe(
      [
        "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment",
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Second comment",
        "",
      ].join("\n"),
    );

    expect(
      (await runZinn(["task", "comment", "edit", "NOTE-1#2", "--text", "Edited"], dir, { FORCE_COLOR: "1" })).stdout,
    ).toBe(`NOTE-1#2${DIM_SEPARATOR}Edited\n`);
    expect((await runZinn(["task", "comment", "edit", "NOTE-1#2", "--text", "Edited again"], dir)).stdout).toBe(
      "NOTE-1#2 | Edited again\n",
    );
  });
});

test.serial("task text output names labels without color words when color is off, and JSON keeps plain label names", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    await runZinn(["label", "create", "docs", "--color", "cyan"], dir);
    await runZinn(["project", "create", "TAGS"], dir);
    await runZinn(["task", "create", "TAGS", "--title", "Tagged", "--priority", "urgent", "--label", "docs", "--label", "bug"], dir);

    const plainRow = "TAGS-1 | Backlog | U | Tagged | bug, docs\n";
    const detailRow = "TAGS-1 | Backlog | Urgent | Tagged | bug, docs\n";
    const colorOff = { FORCE_COLOR: "0" };
    const noColor = { NO_COLOR: "1" };

    // Piped, with color forced off, and with NO_COLOR in a terminal all read alike, with no color words.
    expect((await runZinn(["task", "list", "TAGS"], dir)).stdout).toBe(plainRow);
    expect((await runZinn(["task", "list", "TAGS"], dir, colorOff)).stdout).toBe(plainRow);
    expect((await runZinnInTerminal(["task", "list", "TAGS"], dir, noColor)).output).toBe(plainRow);
    expect(taskViewContent((await runZinn(["task", "view", "TAGS-1"], dir)).stdout)).toBe(detailRow);
    expect(taskViewContent((await runZinn(["task", "view", "TAGS-1"], dir, colorOff)).stdout)).toBe(detailRow);
    expect(taskViewContent((await runZinnInTerminal(["task", "view", "TAGS-1"], dir, noColor)).output)).toBe(detailRow);

    for (const args of [["task", "list", "TAGS", "--json"], ["task", "view", "TAGS-1", "--json"]]) {
      for (const env of [{}, { FORCE_COLOR: "1" }] as Array<Record<string, string>>) {
        const json = (await runZinn(args, dir, env)).stdout;
        expect(json).not.toContain("\x1b");
        expect([JSON.parse(json)].flat()[0].labels).toEqual(["bug", "docs"]);
      }
    }
  });
});

test.serial("label deletion and cancellation print the label preview on stdout with color on and off", async () => {
  for (const forceColor of ["0", "1"]) {
    await withIsolatedZinnDir(async (dir) => {
      const colorEnv = { FORCE_COLOR: forceColor };
      const created = await runZinn(
        ["label", "create", "bug", "--color", "red", "--description", "First line\nFull description"],
        dir,
        colorEnv,
      );
      expect(created.code).toBe(0);
      const row = created.stdout.trimEnd();
      expect(row).toContain("bug");
      expect(row).toContain("First line…");
      expect(row).not.toContain("Full description");
      if (forceColor === "0") {
        expect(row).toContain("red");
        expect(row).not.toContain("\x1b");
      } else {
        expect(row).toContain("\x1b[31mbug\x1b[39m");
        expect(row).not.toContain("red");
      }

      const stderrPath = join(dir, "prompt.stderr");
      const cancelled = await runCliInTerminal(["label", "delete", "bug"], {
        env: { ...TEST_ENVIRONMENT, ...colorEnv, ZINN_DIR: dir },
        cwd: dir,
        input: "n\n",
        stderrPath,
      });
      expect(cancelled.code).toBe(0);
      expect(cancelled.output).toContain(row);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("First line");
      expect((await runZinn(["label", "list"], dir, colorEnv)).stdout.trimEnd()).toBe(row);

      const deleted = await runZinn(["label", "delete", "bug", "--yes"], dir, colorEnv);
      expect(deleted.code).toBe(0);
      expect(deleted.stdout).toContain(row);
      expect(deleted.stderr).toBe("");
      expect((await runZinn(["label", "list", "--json"], dir)).stdout.trim()).toBe("[]");
    });
  }
});

test.serial("label deletion confirms global removal and cancellation preserves attachments and timestamps", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("project", "create", "APP");
    await run("label", "create", "bug");
    await run("label", "create", "keep");
    await run("task", "create", "APP", "--title", "First", "--label", "bug", "--label", "keep");
    await run("task", "create", "APP", "--title", "Second", "--label", "bug");
    const snapshot = () => withTestDb(dir, (db) => ({
      labels: db.query("SELECT * FROM label ORDER BY id").all(),
      attachments: db.query("SELECT * FROM task_label ORDER BY task_id, label_id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
    }));
    const before = snapshot();
    const cancelled = await runCliInTerminal(["label", "delete", "bug"], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir, input: "n\n" });
    expect(cancelled.code).toBe(0);
    expect(cancelled.output).toContain("bug");
    expect(cancelled.output).toContain("[y/N]");
    expect(snapshot()).toEqual(before);
    const deleted = await runZinn(["label", "delete", "bug", "--yes"], dir);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain("bug");
    expect((await run("label", "list")).stdout).toContain("keep");
    expect((await run("label", "list")).stdout).not.toContain("bug");
    expect(taskViewContent((await run("task", "view", "APP-1")).stdout)).toBe("APP-1 | Backlog | - | First | keep\n");
    expect((await run("task", "view", "APP-2")).code).toBe(0);
    withTestDb(dir, (db) => {
      expect(db.query("SELECT * FROM task_label").all()).toHaveLength(1);
      expect(db.query("SELECT * FROM task").all()).toHaveLength(2);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    const missing = await run("label", "delete", "missing");
    expect(missing.code).toBe(1);
    expect(missing.stdout).not.toContain("Are you sure");
    expect((await run("label", "delete", "--help")).stdout).toContain("Usage: zinn label delete");
  });
});

test("shared option checks reject repeated scalar flags and retain positional validation", async () => {
  await withIsolatedZinnDir(async (dir) => {
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
      const result = await runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(args[args.length - 2]!);
    }
    // ? Each case lists the facts its error carries.
    const labelWordCases: Array<[string[], ...string[]]> = [
      [["label", "create"], "Usage: zinn label create"],
      [["label", "create", "one", "two"], `"two"`, "Usage: zinn label create"],
      [["label", "edit"], "Usage: zinn label edit"],
      [["label", "edit", "one", "two", "--color", "red"], `"two"`, "Usage: zinn label edit"],
    ];
    for (const [args, ...facts] of labelWordCases) {
      const result = await runZinn(args, dir);
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
    }
    const extraLabel = await runZinn(["label", "delete", "one", "two"], dir);
    expect(extraLabel.stderr).toContain(`"two"`);
    expect(extraLabel.stderr).toContain("Usage: zinn label delete");
  });
});

test("label edit validates changes, uniqueness, and missing labels", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("label", "create", "bug");
    await run("label", "create", "auth");

    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "edit", "bug")).stderr)).error).toMatchObject({ code: "invalid_input", details: { field: [] } });
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "edit", "missing", "--color", "red")).stderr)).error).toMatchObject({ code: "not_found", details: { entity: "label", key: "missing" } });
    expect((await run("label", "edit", "BUG", "--name", "Bug")).stdout).toContain("Bug");
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "edit", "bug", "--name", "AUTH")).stderr)).error).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "label", key: "AUTH" } });
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "edit", "BUG", "--name", " ")).stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["name"] } });
    expect((await run("label", "edit", "BUG", "--color", "purple")).code).toBe(1);
    expect((await run("label", "list", "--json")).stdout).toContain('"name": "Bug"');
    expect((await runZinn(["--help"], dir)).stdout).toContain("label {create|list|view|edit|delete}");
  });
});

test("priority inputs accept any letter case on create and edit and persist canonical values", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "PRI"], directory)).code).toBe(0);
    for (const priority of [...taskPrioritySchema.options, "none"]) {
      const expectedPriority = priority === "none" ? null : priority;
      const inputs = [
        priority.toUpperCase(),
        priority[0]!.toUpperCase() + priority.slice(1),
        [...priority].map((letter, index) => index % 2 === 0 ? letter : letter.toUpperCase()).join(""),
      ];
      for (const input of inputs) {
        const created = await runZinn(["task", "create", "PRI", "--title", "Case test", "--priority", input, "--json"], directory);
        expect(created.code, created.stderr).toBe(0);
        const taskKey = JSON.parse(created.stdout).key;
        expect(JSON.parse(created.stdout).priority).toBe(expectedPriority);
        const initialPriority = expectedPriority === "high" ? "low" : "high";
        expect((await runZinn(["task", "edit", taskKey, "--priority", initialPriority], directory)).code).toBe(0);
        const edited = await runZinn(["task", "edit", taskKey, "--priority", input, "--json"], directory);
        expect(edited.code, edited.stderr).toBe(0);
        expect(JSON.parse(edited.stdout).priority).toBe(expectedPriority);
        expect(JSON.parse((await runZinn(["task", "view", taskKey, "--json"], directory)).stdout).priority).toBe(expectedPriority);
        withTestDb(directory, (db) => {
          const stored = db.query<{ priority: string | null }, [number]>("SELECT priority FROM task WHERE number = ?").get(Number(taskKey.slice("PRI-".length)))!;
          expect(stored.priority).toBe(expectedPriority);
        });
      }
    }
    const before = (await runZinn(["task", "list", "PRI", "--json"], directory)).stdout;
    for (const args of [
      ["task", "create", "PRI", "--title", "Invalid"],
      ["task", "edit", "PRI-1", "--title", "Invalid"],
    ]) {
      const invalid = await runZinn([...args, "--priority", "CRITICAL", "--json"], directory);
      expect(invalid.code).toBe(1);
      expect(invalid.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(invalid.stderr)).error).toMatchObject({
        code: "invalid_input", details: { argument: "--priority" },
      });
    }
    expect((await runZinn(["task", "list", "PRI", "--json"], directory)).stdout).toBe(before);
  });
});

test("priority persists across CLI creation, editing, listing, clearing, and no-op edits", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "PRI"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "PRI", "--title", "Default"], directory)).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ priority: string | null }, []>("SELECT priority FROM task").get()!.priority).toBeNull();
    });
    for (const [index, priority] of ["low", "medium", "high", "urgent"].entries()) {
      const created = await runZinn(["task", "create", "PRI", "--title", priority, "--priority", priority], directory);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain(`| Backlog | ${priority[0]!.toUpperCase()} | ${priority}`);
      const taskKey = `PRI-${index + 2}`;
      const viewed = await runZinn(["task", "view", taskKey], directory);
      expect(taskViewContent(viewed.stdout)).toBe(`${taskKey} | Backlog | ${priority[0]!.toUpperCase()}${priority.slice(1)} | ${priority}\n`);
      expect(JSON.parse((await runZinn(["task", "view", taskKey, "--json"], directory)).stdout).priority).toBe(priority);
    }
    expect((await runZinn(["task", "list", "PRI"], directory)).stdout).toBe(
      [
        `PRI-1 | Backlog | - | Default`,
        `PRI-2 | Backlog | L | low`,
        `PRI-3 | Backlog | M | medium`,
        `PRI-4 | Backlog | H | high`,
        `PRI-5 | Backlog | U | urgent`,
      ].join("\n") + "\n",
    );
    withTestDb(directory, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));
    expect((await runZinn(["task", "edit", "PRI-1", "--priority", "high"], directory)).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1").get()!.updated_at).toBeGreaterThan(1);
    });
    withTestDb(directory, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));
    expect((await runZinn(["task", "edit", "PRI-1", "--priority", "high"], directory)).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1").get()!.updated_at).toBe(1);
    });
    expect((await runZinn(["task", "edit", "PRI-1", "--title", "Renamed"], directory)).stdout).toBe(
      "PRI-1 | Backlog | H | Renamed\n",
    );
    expect((await runZinn(["task", "list", "PRI"], directory)).stdout).toContain(
      `PRI-1 | Backlog | H | Renamed`,
    );
    expect(taskViewContent((await runZinn(["task", "view", "PRI-1"], directory)).stdout)).toBe("PRI-1 | Backlog | High | Renamed\n");
    expect(JSON.parse((await runZinn(["task", "list", "PRI", "--json"], directory)).stdout)[0].priority).toBe(
      "high",
    );
    const invalid = await runZinn(["task", "edit", "PRI-1", "--title", "Wrong", "--priority", "critical"], directory);
    expect(invalid.code).not.toBe(0);
    expect((await runZinn(["task", "view", "PRI-1"], directory)).stdout).toContain("Renamed");
    expect((await runZinn(["task", "archive", "PRI-1"], directory)).code).toBe(0);
    expect((await runZinn(["task", "edit", "PRI-1", "--priority", "none"], directory)).code).toBe(0);
    withTestDb(directory, (db) => {
      const row = db.query<{ priority: string | null; archived_at: number | null }, []>("SELECT priority, archived_at FROM task WHERE number = 1").get()!;
      expect(row.priority).toBeNull();
      expect(row.archived_at).not.toBeNull();
    });
  });
});

// --- ACTIVITY ACTOR

async function runZinnAs(args: Array<string>, testDir: string, env: Record<string, string>) {
  // ? cwd outside any repository, so only the identity file given per case applies.
  return runProcessAsync([process.execPath, CLI_PATH, ...args], { cwd: testDir, env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir, ...env } });
}

function lastActor(testDir: string) {
  return withTestDb(testDir, (db) =>
    db.query<{ action: string; actor_name: string | null; actor_email: string | null; actor_kind: string; actor_source: string | null }, []>(
      "SELECT action, actor_name, actor_email, actor_kind, actor_source FROM activity ORDER BY id DESC LIMIT 1",
    ).get(),
  );
}

test("mutations record the invoking agent, then the git identity, then the OS user", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const identityFile = join(dir, "gitconfig");
    writeFileSync(identityFile, "[user]\n\tname = Git Person\n\temail = git@example.com\n");

    expect((await runZinnAs(["project", "create", "ACT"], dir, { AI_AGENT: "project-agent" })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "project-agent", actor_email: null, actor_kind: "agent", actor_source: "env:AI_AGENT" });
    expect((await runZinnAs(["task", "create", "ACT", "--title", "Tracked"], dir, { AI_AGENT: "test-agent_1-0" })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "test-agent_1-0", actor_email: null, actor_kind: "agent", actor_source: "env:AI_AGENT" });

    expect((await runZinnAs(["task", "move", "ACT-1", "TODO"], dir, { GIT_CONFIG_GLOBAL: identityFile })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "move", actor_name: "Git Person", actor_email: "git@example.com", actor_kind: "human", actor_source: "git-config" });

    expect((await runZinnAs(["task", "archive", "ACT-1"], dir, { GIT_CONFIG_GLOBAL: "/dev/null", USER: userInfo().username })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "archive", actor_name: userInfo().username, actor_email: null, actor_kind: "human", actor_source: "os-user" });
  });
});

test("CLI mutations preserve declared identity pairs and metadata without recording no-ops or failures", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const declared = {
      AI_AGENT: "integration-client", ZINN_SESSION_ID: " conversation ", ZINN_THREAD_ID: " child ",
      ZINN_AGENT: " Explore ", ZINN_MODEL: " provider/model ", ZINN_EFFORT: " 0.7 ",
      CLAUDE_CODE_SESSION_ID: "native-session", CODEX_SESSION_ID: "codex-session", CODEX_THREAD_ID: "codex-thread",
    };
    const events = async (): Promise<Array<Activity>> => JSON.parse((await runZinn(["activity", "list", "--json"], directory)).stdout);
    expect((await runZinnAs(["project", "create", "IDENTITY"], directory, declared)).code).toBe(0);
    expect((await runZinnAs(["task", "create", "IDENTITY", "--title", "Tracked"], directory, declared)).code).toBe(0);
    const item = (await events())[0]!;
    expect(item).toMatchObject({
      actor_name: "integration-client", actor_kind: "agent", actor_source: "env:AI_AGENT",
      actor_session_id: "conversation", actor_thread_id: "child", actor_agent: "Explore",
      actor_model: "provider/model", actor_effort: "0.7",
    });
    const before = await events();
    expect((await runZinnAs(["task", "edit", "IDENTITY-1", "--title", "Tracked"], directory, declared)).code).toBe(0);
    expect((await runZinnAs(["task", "move", "IDENTITY-1", "Missing"], directory, declared)).code).toBe(1);
    expect(await events()).toEqual(before);

    const cases: Array<{ env: Record<string, string>; name: string | null; session: string | null; thread: string | null }> = [
      { env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "claude-root", CODEX_SESSION_ID: "outer-root", CODEX_THREAD_ID: "outer-thread" }, name: "claude-code", session: "claude-root", thread: null },
      { env: { CODEX_SESSION_ID: "codex-root", CODEX_THREAD_ID: "codex-root" }, name: "codex", session: "codex-root", thread: "codex-root" },
      { env: { CODEX_SESSION_ID: "codex-root", CODEX_THREAD_ID: "codex-child" }, name: "codex", session: "codex-root", thread: "codex-child" },
      { env: { CODEX_SESSION_ID: "outer-root", CODEX_THREAD_ID: "outer-thread", ZINN_THREAD_ID: "explicit-child" }, name: "codex", session: null, thread: "explicit-child" },
      { env: { AGENT: "1", OPENCODE: "1" }, name: "opencode", session: null, thread: null },
      { env: { AGENT: "1" }, name: null, session: null, thread: null },
    ];
    for (const [index, entry] of cases.entries()) {
      expect((await runZinnAs(["task", "edit", "IDENTITY-1", "--title", `Change ${index}`], directory, entry.env)).code).toBe(0);
      expect((await events())[0]).toMatchObject({
        actor_name: entry.name, actor_kind: "agent", actor_session_id: entry.session, actor_thread_id: entry.thread,
        actor_agent: null, actor_model: null, actor_effort: null,
      });
    }
    const unnamed = (await events())[0]!;
    expect(unnamed.actor_source).toBe("env:AGENT");
    expect((await runZinn(["activity", "list", "--limit", "1"], directory)).stdout).toContain("unknown (agent)");
    const view = await runZinn(["activity", "view", unnamed.id], directory);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain("unknown");
    expect(JSON.parse((await runZinn(["activity", "view", unnamed.id, "--json"], directory)).stdout).actor_name).toBeNull();
  });
});

// --- BACKUP

test("backup saves a copy of the database named with the UTC time and CLI version", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "BAK"], dir);
    await runZinn(["task", "create", "BAK", "--title", "Saved"], dir);

    const result = await runZinn(["backup", "--json"], dir);
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

test("backup refuses when there is no database and does not create one", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["--json", "backup"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath: join(dir, "data", "zinn.sqlite") } });
    expect(existsSync(join(dir, "data"))).toBe(false);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("backup refuses a zero-byte database file without creating backups", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    writeFileSync(databasePath, "");

    const result = await runZinn(["--json", "backup"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath } });
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath).length).toBe(0);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("backup refuses a database header with no tables without creating backups", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    const db = new Database(databasePath);
    db.exec("PRAGMA user_version = 0");
    db.close();
    const before = readFileSync(databasePath);
    expect(before.length).toBeGreaterThan(0);

    const result = await runZinn(["--json", "backup"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath } });
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

// --- RESTORE

// ? A backup of a fresh store holding one task, made by the CLI, in its own directory.
async function backupWithTask(dir: string, title: string) {
  await runZinn(["project", "create", "RST"], dir);
  await runZinn(["task", "create", "RST", "--title", title], dir);
  return (JSON.parse((await runZinn(["backup", "--json"], dir)).stdout) as { path: string }).path;
}

function taskTitles(dir: string) {
  return withTestDb(dir, (db) => db.query("SELECT title FROM task ORDER BY number").all());
}

function backupFiles(dir: string) {
  return existsSync(join(dir, "backups")) ? readdirSync(join(dir, "backups")).sort() : [];
}

test("restore explains recovery from damaged task and comment pages without changing the database", async () => {
  for (const table of ["task", "comment"]) {
    await withIsolatedZinnDir(async (dir) => {
      const path = await backupWithTask(dir, "Kept");
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

      const result = await runZinn(["restore", path, "--yes"], dir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(databasePath);
      const json = await runZinn(["restore", path, "--yes", "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(json.stderr)).error)
        .toMatchObject({ code: "storage", details: { reason: "corrupt" } });
      expect(result.stderr).toContain(`${databasePath}-wal`);
      expect(result.stderr).toContain(`${databasePath}-shm`);
      expect(result.stderr).toContain("zinn restore");
      expect(result.stderr).not.toContain("[y/N]");
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

      const recovered = await runZinn(["restore", path, "--yes"], dir);
      expect(recovered.code).toBe(0);
      expect(recovered.stderr).toBe("");
      expect(taskTitles(dir)).toEqual([{ title: "Kept" }]);
      expect(readFileSync(join(saved, "zinn.sqlite"))).toEqual(damaged);
    });
  }
});

test("restore replaces the database after confirmation and saves the replaced database as a backup", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const path = await backupWithTask(dir, "Kept");
    await runZinn(["task", "create", "RST", "--title", "Later"], dir);

    const result = await runZinn(["restore", path, "--yes"], dir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(path);
    expect(result.stdout).toContain(`schema version ${CURRENT_SCHEMA_VERSION}`);
    expect(result.stdout).toContain(`${join(dir, "backups")}/`);
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

test.serial("restore keeps the database when confirmation is declined", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const path = await backupWithTask(dir, "Kept");
    await runZinn(["task", "create", "RST", "--title", "Later"], dir);
    const backupsBefore = backupFiles(dir);

    const result = await runCliInTerminal(["restore", path], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir, input: "n\n" });

    expect(result.code).toBe(0);
    expect(result.output).toContain(join(dir, "data", "zinn.sqlite"));
    expect(result.output).toContain(path);
    expect(result.output).toContain("[y/N]");
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }, { title: "Later" }]);
    expect(backupFiles(dir)).toEqual(backupsBefore);
  });
});

test("restore with --json needs --yes, and with it prints the restore result", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const path = await backupWithTask(dir, "Kept");
    await runZinn(["task", "create", "RST", "--title", "Later"], dir);
    const backupsBefore = backupFiles(dir);

    const refused = await runZinn(["restore", path, "--json"], dir);
    expect(refused.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(refused.stderr)).error).toMatchObject({
      code: "invalid_input", details: { argument: "--yes", reason: "confirmation_required" },
    });
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }, { title: "Later" }]);
    expect(backupFiles(dir)).toEqual(backupsBefore);

    const result = await runZinn(["restore", path, "--yes", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const restored = JSON.parse(result.stdout);
    expect(restored).toEqual({
      databasePath: realpathSync(join(dir, "data", "zinn.sqlite")),
      previousVersion: CURRENT_SCHEMA_VERSION,
      restoredVersion: CURRENT_SCHEMA_VERSION,
      backupPath: expect.any(String),
    });
    expect(dirname(restored.backupPath)).toBe(join(dir, "backups"));
    expect(existsSync(restored.backupPath)).toBe(true);
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }]);
  });
});

test("restore refuses a file that is not a backup it can restore, printing why and changing nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await withIsolatedZinnDir(async (newerDir) => {
      await createDatabase(dir, 1);
      const before = databaseSnapshot(dir);
      const textFile = join(newerDir, "notes.sqlite");
      writeFileSync(textFile, "not a database");
      const newer = await backupWithTask(newerDir, "From the future");
      withTestDb(newerDir, (db) => db.run("PRAGMA user_version = 9"));
      const newerBackup = (JSON.parse((await runZinn(["backup", "--json"], newerDir)).stdout) as { path: string }).path;

      const notDatabase = await runZinn(["restore", textFile, "--yes"], dir);
      expect(notDatabase.code).toBe(1);
      expect(notDatabase.stdout).toBe("");
      expect(notDatabase.stderr).toContain(textFile);

      // ? Without --yes, the refusal comes before the prompt.
      const newerResult = await runZinn(["restore", newerBackup], dir);
      expect(newerResult.code).toBe(1);
      expect(newerResult.stdout).toBe("");
      expect(newerResult.stderr).toContain(newerBackup);
      expect(newerResult.stderr).toContain("9");
      expect(newerResult.stderr).toContain("cli");
      expect(newerResult.stderr).toContain(packageJson.version);
      expect(newerResult.stderr).not.toContain("[y/N]");

      const missing = await runZinn(["restore", join(newerDir, "missing.sqlite"), "--yes", "--json"], dir);
      expect(missing.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(missing.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "backup", backupPath: join(newerDir, "missing.sqlite") } });

      expect(databaseSnapshot(dir)).toEqual(before);
      expect(existsSync(join(dir, "backups"))).toBe(false);
      expect(newer).not.toBe(newerBackup);
    });
  });
});

test("a refused restore onto a store with no database creates nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await withIsolatedZinnDir(async (otherDir) => {
      const textFile = join(otherDir, "notes.sqlite");
      writeFileSync(textFile, "not a database");

      expect((await runZinn(["restore", textFile, "--yes"], dir)).code).toBe(1);
      expect((await runZinn(["restore", textFile], dir)).code).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});

test("restore onto a store with no database creates it from the backup", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await withIsolatedZinnDir(async (sourceDir) => {
      const path = await backupWithTask(sourceDir, "Kept");

      const result = await runZinn(["restore", path, "--yes"], dir);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(path);
      expect(result.stdout).toContain(`schema version ${CURRENT_SCHEMA_VERSION}`);
      expect(backupFiles(dir)).toEqual([]);
      expect((await runZinn(["task", "list", "RST"], dir)).stdout).toContain("Kept");
    });
  });
});

test("restore works on newer and unmarked databases, without --allow-legacy-read", async () => {
  await withIsolatedZinnDir(async (sourceDir) => {
    const path = await backupWithTask(sourceDir, "Kept");

    for (const version of [9, 0]) {
      await withIsolatedZinnDir(async (dir) => {
        await createDatabase(dir, version);

        const result = await runZinn(["restore", path, "--yes", "--json"], dir);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ previousVersion: version, restoredVersion: CURRENT_SCHEMA_VERSION });
        expect((await runZinn(["task", "list", "RST"], dir)).stdout).toContain("Kept");
        expect(backupFiles(dir)).toHaveLength(1);
      });
    }
  });
});

test("restore needs exactly one backup path", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["restore", "--yes"], dir);

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

async function createDatabase(dir: string, version: number) {
  await runZinn(["project", "create", "MIG"], dir);
  await runZinn(["task", "create", "MIG", "--title", "Kept"], dir);
  withTestDb(dir, (db) => db.run(`PRAGMA user_version = ${version}`));
}

test("migrate refuses when there is no database and creates no files", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["--json", "migrate"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
    expect(result.stderr).not.toContain("[y/N]");
    expect(readdirSync(dir)).toEqual([]);
  });
});

test("migrate refuses an empty database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    mkdirSync(join(dir, "data"));
    new Database(join(dir, "data", "zinn.sqlite")).close();
    const before = readFileSync(join(dir, "data", "zinn.sqlite"));
    const result = await runZinn(["--json", "migrate"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
    expect(readFileSync(join(dir, "data", "zinn.sqlite"))).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate refuses an unmarked database, with or without --allow-legacy-read, and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["migrate", "--json"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database", schemaVersion: 0 } });

    expect((await runZinn(["migrate", "--allow-legacy-read"], dir)).code).toBe(1);
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate refuses a newer database and reports both versions and the CLI version", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["--json", "migrate"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", schemaVersion: 9, supportedSchemaVersion: CURRENT_SCHEMA_VERSION } });

    expect(result.stderr).not.toContain("[y/N]");
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate on a current database is a no-op with no backup", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, CURRENT_SCHEMA_VERSION);
    const before = databaseSnapshot(dir);

    const result = await runZinn(["migrate", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      databasePath: join(dir, "data", "zinn.sqlite"),
      previousVersion: CURRENT_SCHEMA_VERSION,
      finalVersion: CURRENT_SCHEMA_VERSION,
      changed: false,
      backupPath: null,
    });
    expect((await runZinn(["migrate"], dir)).stdout).toContain(String(CURRENT_SCHEMA_VERSION));
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

// --- REINDEX (ZINN-49)

test("reindex rebuilds a missing search index from the tasks and comments, archived ones included", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Gadget export"], dir);
    await runZinn(["task", "comment", "create", "IDX-1", "--text", "Needs a spinner"], dir);
    await runZinn(["task", "archive", "IDX-2"], dir);
    const before = databaseSnapshot(dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_search"));

    expect((await runZinn(["task", "search", "spinner"], dir)).code).toBe(1);

    const result = await runZinn(["reindex", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      databasePath: join(realpathSync(dir), "data", "zinn.sqlite"),
      taskCount: 2,
    });
    expect((await runZinn(["task", "search", "spinner"], dir)).stdout).toContain("IDX-1");
    expect((await runZinn(["task", "search", "gadget", "--archived"], dir)).stdout).toContain("IDX-2");
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);

    expect((await runZinn(["reindex"], dir)).stdout).toContain("2");
  });
});

test("a missing search index points search and index-updating writes at reindex, changing nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
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
      const plain = await runZinn(args, dir);
      expect(plain.code).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain("task_search");
      expect(plain.stderr).toContain("zinn reindex");

      const json = await runZinn([...args, "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(json.stderr)).error).toMatchObject({ code: "storage", details: { reason: "missing_index" } });
      expect(JSON.parse(json.stderr).error.message).toContain("task_search");
      expect(JSON.parse(json.stderr).error.message).toContain("zinn reindex");
    }
    expect({ snapshot: databaseSnapshot(dir), rows: countRows() }).toEqual(before);
  });
});

test("a missing table other than the search index gets no reindex hint", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_label; DROP TABLE label"));
    const result = await runZinn(["label", "list"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("label");
    expect(result.stderr).not.toContain("reindex");
  });
});

test("reindex refuses when there is no database and creates no files", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath: join(dir, "data", "zinn.sqlite") } });
    expect(readdirSync(dir)).toEqual([]);
  });
});

test("reindex refuses an empty database file and leaves it empty", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    writeFileSync(databasePath, "");
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { databasePath } });
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath).length).toBe(0);
  });
});

test("reindex refuses a newer database and leaves it unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", schemaVersion: 9 } });

    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

// --- READ-ONLY DATABASES (ZINN-118)

test("a newer database refuses changes, naming both versions and this CLI, while reads still work", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);

    const list = await runZinn(["task", "list", "MIG"], dir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("Kept");

    const created = await runZinn(["--json", "task", "create", "MIG", "--title", "Refused"], dir);
    expect(created.code).toBe(1);
    expect(created.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(created.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", databasePath: join(dir, "data", "zinn.sqlite"), schemaVersion: 9, supportedSchemaVersion: CURRENT_SCHEMA_VERSION } });

    for (const fact of ["cli", packageJson.version, CLI_PATH]) {
      expect(JSON.parse(created.stderr).error.message).toContain(fact);
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("task delete on a read-only database refuses before asking for confirmation", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinnWithPipedYes(["--json", "task", "delete", "MIG-1"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database" } });
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("an unmarked database is refused, for reads and writes, and left unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);

    for (const args of [["task", "list", "MIG"], ["task", "create", "MIG", "--title", "Refused"]]) {
      const result = await runZinn(["--json", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database", schemaVersion: 0, databasePath: join(dir, "data", "zinn.sqlite") } });
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

// --- LEGACY READS (ZINN-119)

const LEGACY_FLAG = "--allow-legacy-read";

function warningLines(stderr: string, databasePath: string) {
  return stderr.split("\n").filter((line) => line.includes(databasePath));
}

test("--allow-legacy-read reads an unmarked database with one warning on stderr, each invocation needing it again", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const databasePath = join(dir, "data", "zinn.sqlite");

    for (const args of [["task", "list", "MIG", LEGACY_FLAG], [LEGACY_FLAG, "project", "list"], ["task", "view", "MIG-1", LEGACY_FLAG]]) {
      const allowed = await runZinn(args, dir);
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toContain("MIG");
      expect(warningLines(allowed.stderr, join(dir, "data", "zinn.sqlite"))).toHaveLength(1);
      expect(allowed.stderr).toContain(databasePath);
    }

    const refused = await runZinn(["task", "list", "MIG"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(LEGACY_FLAG);
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("--allow-legacy-read with --json keeps stdout parseable and refusals as a JSON error", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);

    const allowed = await runZinn(["task", "list", "MIG", "--json", LEGACY_FLAG], dir);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toHaveLength(1);
    expect(warningLines(allowed.stderr, join(dir, "data", "zinn.sqlite"))).toHaveLength(1);

    const refused = await runZinn(["task", "list", "MIG", "--json"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr).error.message).toContain(LEGACY_FLAG);
  });
});

test("a --allow-legacy-read after -- is command input, so the database stays refused", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["--json", "task", "search", "--", LEGACY_FLAG], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database" } });
    expect(result.stderr).not.toContain("Warning:");
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("--allow-legacy-read never lets a command change an unmarked database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const attempts = [
      ["task", "create", "MIG", "--title", "Refused"],
      ["task", "edit", "MIG-1", "--title", "Refused"],
      ["task", "delete", "MIG-1", "--yes"],
      ["project", "create", "NEW"],
    ];

    for (const args of attempts) {
      const result = await runZinn(["--json", ...args, LEGACY_FLAG], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database", schemaVersion: 0 } });

    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("--allow-legacy-read does not warn about a database that has a schema version", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 1);
    const current = await runZinn(["task", "list", "MIG", LEGACY_FLAG], dir);
    expect(current.code).toBe(0);
    expect(current.stderr).toBe("");

    withTestDb(dir, (db) => db.run("PRAGMA user_version = 9"));
    const newer = await runZinn(["task", "list", "MIG", LEGACY_FLAG], dir);
    expect(newer.code).toBe(0);
    expect(newer.stderr).toBe("");
  });
});

test("help, --version and backup need no --allow-legacy-read for an unmarked database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);

    expect((await runZinn(["--help"], dir)).stdout).toContain(LEGACY_FLAG);
    expect((await runZinn(["--version"], dir)).code).toBe(0);

    const backup = await runZinn(["backup", "--json"], dir);
    expect(backup.code).toBe(0);
    expect(backup.stderr).toBe("");
    expect(existsSync(JSON.parse(backup.stdout).path)).toBe(true);
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("help and --version open no database, not even one that core refuses", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const commands = [["--version"], ["--help"], ["task", "--help"], ["task", "create", "--help"]];

    for (const args of commands) {
      expect((await runZinn(args, dir)).code).toBe(0);
    }
    expect(readdirSync(dir)).toEqual([]);

    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    for (const args of commands) {
      const result = await runZinn(args, dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("simultaneous backup commands create distinct valid snapshots", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "BAK"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "BAK", "--title", "Saved"], dir)).code).toBe(0);

    const results = await Promise.all(Array.from({ length: 4 }, () => runZinn(["backup", "--json"], dir, { AI_AGENT: "concurrency-test" })));
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

test("all CLI descriptions normalize blank input and preserve meaningful formatting", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect((await run("project", "create", "APP")).code).toBe(0);
    const entities = [
      { type: "project", create: ["EMPTY"], editKey: "EMPTY", read: ["project", "view", "EMPTY"] },
      { type: "task", create: ["APP", "--title", "Empty"], editKey: "APP-1", read: ["task", "view", "APP-1"] },
      { type: "label", create: ["empty"], editKey: "empty", read: ["label", "list"] },
    ];

    for (const entity of entities) {
      const created = await run(entity.type, "create", ...entity.create, "--description", " \n\t ", "--json");
      expect(created.code).toBe(0);
      expect(JSON.parse(created.stdout).description).toBeNull();
      for (const clearInput of ["", " \n\t "]) {
        const description = "  Details\n\tIndented  \n";
        const edited = await run(entity.type, "edit", entity.editKey, "--description", description, "--json");
        expect(edited.code).toBe(0);
        expect(JSON.parse(edited.stdout).description).toBe(description);
        const cleared = await run(entity.type, "edit", entity.editKey, "--description", clearInput, "--json");
        expect(cleared.code).toBe(0);
        expect(JSON.parse(cleared.stdout).description).toBeNull();
      }
      const result = JSON.parse((await run(...entity.read, "--json")).stdout);
      expect((Array.isArray(result) ? result[0] : result).description).toBeNull();
    }

    expect(JSON.parse((await run("project", "create", "OMITTED", "--json")).stdout).description).toBeNull();
    expect(JSON.parse((await run("task", "create", "APP", "--title", "Omitted", "--json")).stdout).description).toBeNull();
    expect(JSON.parse((await run("label", "create", "omitted", "--json")).stdout).description).toBeNull();
  });
});

test("project descriptions flow through creation, partial edits, view, list and clearing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "Purpose\nMore context";
    const created = await run("project", "create", "DESC", "--description", description, "--json");
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ id: expect.any(String), key: "DESC", name: "DESC", description });
    expect((await run("project", "view", "DESC")).stdout).toStartWith(`DESC | DESC\n\nDescription:\n${description}\n\nColumns:\n`);
    expect((await run("project", "list")).stdout).toBe("DESC | DESC | 0 active | 0 archived | Purpose More context\n");
    expect(JSON.parse((await run("project", "list", "--json")).stdout)[0].description).toBe(description);
    expect(JSON.parse((await run("project", "edit", "DESC", "--name", "Renamed", "--json")).stdout).description).toBe(description);
    expect(JSON.parse((await run("project", "edit", "DESC", "--description", "Updated", "--json")).stdout)).toEqual({ id: expect.any(String), key: "DESC", name: "Renamed", description: "Updated", changed: true });
    expect((await run("project", "edit", "DESC", "--description", "")).stdout).toBe("DESC | Renamed\n");
    expect(JSON.parse((await run("project", "view", "DESC", "--json")).stdout).description).toBeNull();
    expect((await run("project", "edit", "DESC", "--description", "a", "--description", "b")).code).toBe(1);
  });
});

test("project list and write rows show truncated description previews, project view and JSON keep full text, and task rows leave descriptions out", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "  Context\n" + "x".repeat(200);
    const preview = `Context ${"x".repeat(71)}…`;
    expect(preview).toHaveLength(80);
    const taskProject = JSON.parse((await run("project", "create", "PRE", "--description", description, "--json")).stdout);
    await run("task", "create", "PRE", "--title", "Task", "--description", description);
    expect((await run("task", "list", "PRE")).stdout).toBe("PRE-1 | Backlog | - | Task\n");
    expect((await run("project", "list")).stdout).toBe(`PRE | PRE | 1 active | 0 archived | ${preview}\n`);
    expect((await run("project", "view", "PRE")).stdout).toStartWith(`PRE | PRE\n\nDescription:\n${description}\n\nColumns:\n`);
    expect((await run("project", "edit", "PRE", "--description", description)).stdout).toBe(`PRE | PRE | ${preview}\n`);
    expect(taskProject.description).toBe(description);
    expect(JSON.parse((await run("project", "view", "PRE", "--json")).stdout).description).toBe(description);
    expect((await run("project", "edit", "PRE", "--description", " \n ")).stdout).toBe("PRE | PRE\n");
  });
});

// --- CONCURRENCY (ZINN-68)

test("concurrent fresh initialization supports readers and project creators", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const operation of ["list", "create"]) {
      for (let round = 0; round < 3; round++) {
        const store = join(dir, `${operation}-${round}`);
        mkdirSync(store);
        const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
          runZinn(operation === "list"
            ? ["project", "list", "--json"]
            : ["project", "create", `P${index}`, "--json"], store, { AI_AGENT: "concurrency-test" }),
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
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "BEN"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "BEN", "--title", "comment-target"], dir)).code).toBe(0);
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
        return { kind, token, ...await runZinn(args, dir, { AI_AGENT: "concurrency-test" }) };
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

test.serial("a CLI writer waits for a held lock and succeeds after release", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "WAIT"], dir)).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();
    const release = setTimeout(() => db.run("ROLLBACK"), 250);

    try {
      const result = await runZinn(["task", "create", "WAIT", "--title", "waited", "--json"], dir, { AI_AGENT: "concurrency-test" });
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

test.serial("persistent contention times out without a partial CLI mutation", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "LOCK"], dir)).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();

    try {
      const result = await runZinn(["task", "create", "LOCK", "--title", "must not persist", "--json"], dir, { AI_AGENT: "concurrency-test" });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "storage", details: { reason: "busy", cause: { code: "SQLITE_BUSY" } } });
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

test("CLI initialization errors expose the underlying message and code", async () => {
  await withIsolatedZinnDir(async (dir) => {
    mkdirSync(join(dir, "data"));
    const contents = "not a SQLite database";
    const path = join(dir, "data", "zinn.sqlite");
    writeFileSync(path, contents);
    const result = await runZinn(["project", "list", "--json"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "storage", details: { reason: "not_database", cause: { code: "SQLITE_NOTADB", errcode: 26 } } });

    expect(readFileSync(path, "utf8")).toBe(contents);
  });
});

// --- SETTINGS (ZINN-56)

// ? Runs the bin from cwd with ZINN_DIR unset and a temporary HOME inside testDir, so the settings files choose the store.
async function runZinnFrom(args: Array<string>, testDir: string, cwd: string) {
  const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: join(testDir, "home") };
  delete env.ZINN_DIR;
  return runProcessAsync([process.execPath, CLI_PATH, ...args], { cwd, env });
}

/** A repository inside testDir holding a zinn.local.json with the given content. */
function repositoryWithSettings(testDir: string, content: string) {
  const repository = join(testDir, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(join(testDir, "home"));
  writeFileSync(join(repository, "zinn.local.json"), content);

  return repository;
}

test("storage.directory in zinn.local.json chooses the store, from any folder of the repository", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const repository = repositoryWithSettings(dir, JSON.stringify({ storage: { directory: "../store" } }));
    mkdirSync(join(dir, "store"));
    const nested = join(repository, "src");
    mkdirSync(nested);

    expect((await runZinnFrom(["project", "create", "SET"], dir, repository)).code).toBe(0);
    expect((await runZinnFrom(["project", "list", "--json"], dir, nested)).stdout).toContain('"key": "SET"');
    expect(withTestDb(join(dir, "store"), (db) => db.query("SELECT key FROM project").all())).toEqual([{ key: "SET" }]);
    expect(existsSync(join(dir, "home", ".zinn"))).toBe(false);
  });
});

test("an invalid zinn.local.json fails the command with the file's path, without a stack trace, before creating a store", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const repository = repositoryWithSettings(dir, JSON.stringify({ storage: { directory: 42 } }));
    const settingsPath = join(realpathSync(repository), "zinn.local.json");

    const result = await runZinnFrom(["project", "create", "SET"], dir, repository);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(settingsPath);
    expect(result.stderr).toContain("storage.directory");
    expect(result.stderr).not.toContain("    at ");
    expect(existsSync(join(dir, "home", ".zinn"))).toBe(false);
    expect(readdirSync(repository).sort()).toEqual([".git", "zinn.local.json"]);
  });
});

// --- PARTIAL TEXT EDITS (ZINN-177)

// ? Creates project APP with task APP-1, label bug and comment APP-1#1, all with the given text.
async function seedEditableText(dir: string, text: string) {
  const run = (...args: string[]) => runZinn(args, dir);
  expect((await run("project", "create", "APP", "--description", text)).code).toBe(0);
  expect((await run("task", "create", "APP", "--title", "Task", "--description", text)).code).toBe(0);
  expect((await run("label", "create", "bug", "--description", text)).code).toBe(0);
  expect((await run("task", "comment", "create", "APP-1", "--text", text)).code).toBe(0);

  return run;
}

const storedTextOf = (dir: string) =>
  withTestDb(dir, (db) => ({
    project: db.query<{ text: string | null }, []>("SELECT description AS text FROM project").get()!.text,
    task: db.query<{ text: string | null }, []>("SELECT description AS text FROM task").get()!.text,
    label: db.query<{ text: string | null }, []>("SELECT description AS text FROM label").get()!.text,
    comment: db.query<{ text: string }, []>("SELECT text FROM comment").get()!.text,
  }));

test("oversized partial text edits exit 1 with empty stdout and leave the database unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "Seed");
    const atLimit = "a".repeat(MAX_TEXT_BYTES - 4) + "😀";
    withTestDb(dir, (db) => {
      for (const table of ["project", "task", "label"]) {
        db.query(`UPDATE ${table} SET description = ?`).run(atLimit);
      }
      db.query("UPDATE comment SET text = ?").run(atLimit);
    });
    const before = storedTextOf(dir);
    const activities = (await run("activity", "list", "--json")).stdout;
    const edits = [
      { args: ["project", "edit", "APP"], flag: "--description" },
      { args: ["task", "edit", "APP-1"], flag: "--description" },
      { args: ["label", "edit", "bug"], flag: "--description" },
      { args: ["task", "comment", "edit", "APP-1#1"], flag: "--text" },
    ];
    for (const { args, flag } of edits) {
      for (const options of [[flag, "x", "--append"], [flag, "😀x", "--replacing", "😀"]]) {
        const result = await run(...args, ...options);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(String(MAX_TEXT_BYTES));
        expect(result.stderr).toContain(String(MAX_TEXT_BYTES + (options.includes("--append") ? 3 : 1)));
        expect(storedTextOf(dir)).toEqual(before);
        expect((await run("activity", "list", "--json")).stdout).toBe(activities);
      }
    }
  });
});

test("CRLF text normalizes through CLI creation, replacement and append for every text field", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "  First\r\nSecond\nThird\rEnd  ");
    const normalized = "  First\nSecond\nThird\rEnd  ";
    expect(storedTextOf(dir)).toEqual({ project: normalized, task: normalized, label: normalized, comment: normalized });

    const edits = [
      { args: ["project", "edit", "APP"], flag: "--description" },
      { args: ["task", "edit", "APP-1"], flag: "--description" },
      { args: ["label", "edit", "bug"], flag: "--description" },
      { args: ["task", "comment", "edit", "APP-1#1"], flag: "--text" },
    ];
    for (const { args, flag } of edits) {
      const result = await run(...args, flag, "Joined\r\nLine", "--replacing", "First\r\nSecond", "--json");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const entity = JSON.parse(result.stdout);
      expect(entity.description ?? entity.text).toBe("  Joined\nLine\nThird\rEnd  ");
      expect((await run(...args, flag, "Tail\r\n  Indent", "--append")).code).toBe(0);
    }
    const appended = "  Joined\nLine\nThird\rEnd  \n\nTail\n  Indent";
    expect(storedTextOf(dir)).toEqual({ project: appended, task: appended, label: appended, comment: appended });
  });
});

test("--append adds a paragraph to a task description and to a comment's text", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "First.\n");

    expect((await run("task", "edit", "APP-1", "--description", "Second.", "--append")).code).toBe(0);
    expect((await run("task", "comment", "edit", "APP-1#1", "--text", "More.", "--append")).code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ task: "First.\n\nSecond.", comment: "First.\n\nMore." });
  });
});

test("--replacing swaps one passage in a project description and in a label description", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "old sentence, kept");

    expect((await run("project", "edit", "APP", "--description", "new", "--replacing", "old sentence")).code).toBe(0);
    expect((await run("label", "edit", "bug", "--description", "fresh", "--replacing", "old sentence")).code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ project: "new, kept", label: "fresh, kept" });
  });
});

test("--replacing --all replaces every match and prints the edited object as any edit does", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "board and board");

    const edited = await run("project", "edit", "APP", "--description", "database", "--replacing", "board", "--all");
    expect(edited.code).toBe(0);
    expect(edited.stdout).toContain("database and database");
    expect(storedTextOf(dir).project).toBe("database and database");

    const comment = await run("task", "comment", "edit", "APP-1#1", "--text", "x", "--replacing", "board", "--all");
    expect(comment.code).toBe(0);
    expect(comment.stdout).toContain("x and x");
  });
});

test("--replacing with several matches and no --all fails with the --all hint and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "dup dup");
    const before = storedTextOf(dir);

    const attempts = [
      await run("task", "edit", "APP-1", "--description", "x", "--replacing", "dup", "--json"),
      await run("project", "edit", "APP", "--description", "x", "--replacing", "dup", "--json"),
      await run("task", "comment", "edit", "APP-1#1", "--text", "x", "--replacing", "dup", "--json"),
    ];

    for (const attempt of attempts) {
      expect(attempt.code).toBe(1);
      expect(attempt.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(attempt.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "text_match_count", matchCount: 2 } });
      expect(JSON.parse(attempt.stderr).error.message).toContain("--all");
    }
    expect(storedTextOf(dir)).toEqual(before);
  });
});

test("--replacing with no match fails without the --all hint and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "Some Text");
    const before = storedTextOf(dir);

    const attempts = [
      await run("task", "edit", "APP-1", "--description", "x", "--replacing", "some text", "--json"),
      await run("label", "edit", "bug", "--description", "x", "--replacing", "absent", "--json"),
    ];

    for (const attempt of attempts) {
      expect(attempt.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(attempt.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "text_match_count", matchCount: 0, field: ["description"] } });
      expect(attempt.stderr).not.toContain("--all");
    }
    expect(storedTextOf(dir)).toEqual(before);
  });
});

test("an empty text with --replacing deletes the match", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "keep\nstale line\n");

    expect((await run("task", "edit", "APP-1", "--description", "", "--replacing", "stale line\n")).code).toBe(0);
    expect((await run("task", "comment", "edit", "APP-1#1", "--text", "", "--replacing", "\nstale line")).code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ task: "keep\n", comment: "keep\n" });
  });
});

test("a modifier edit with --json carries the full resulting text", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "One.");

    const task = JSON.parse((await run("task", "edit", "APP-1", "--description", "Two.", "--append", "--json")).stdout);
    const comment = JSON.parse((await run("task", "comment", "edit", "APP-1#1", "--text", "Two.", "--append", "--json")).stdout);

    expect(task.description).toBe("One.\n\nTwo.");
    expect(comment.text).toBe("One.\n\nTwo.");
  });
});

test("a match error with --json uses the usual error shape, with the hint for several matches", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "dup dup");

    const several = await run("task", "edit", "APP-1", "--description", "x", "--replacing", "dup", "--json");
    const none = await run("task", "edit", "APP-1", "--description", "x", "--replacing", "absent", "--json");

    expect(several.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(several.stderr)).error).toMatchObject({
      code: "conflict", details: { reason: "text_match_count", matchCount: 2, field: ["description"] },
    });
    expect(JSON.parse(several.stderr).error.message).toContain("--all");
    expect(errorDocumentSchema.parse(JSON.parse(none.stderr)).error).toMatchObject({
      code: "conflict", details: { reason: "text_match_count", matchCount: 0, field: ["description"] },
    });
  });
});

test("the text-edit flags are usage errors without the text flag or in an invalid combination", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "text");
    const before = storedTextOf(dir);

    const cases: Array<[Array<string>, string]> = [
      [["task", "edit", "APP-1", "--append"], '--append --description'],
      [["project", "edit", "APP", "--name", "New", "--replacing", "a"], '--replacing --description'],
      [["label", "edit", "bug", "--color", "red", "--append"], '--append --description'],
      [["task", "comment", "edit", "APP-1#1", "--replacing", "a"], '--replacing --text'],
      [["task", "edit", "APP-1", "--description", "x", "--all"], '--all --replacing'],
      [["task", "comment", "edit", "APP-1#1", "--text", "x", "--all"], '--all --replacing'],
      [["task", "edit", "APP-1", "--description", "x", "--append", "--replacing", "t"], '--append --replacing'],
      [["task", "comment", "edit", "APP-1#1", "--text", "x", "--append", "--replacing", "t"], '--append --replacing'],
    ];

    for (const [args, message] of cases) {
      const result = await run(...args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      for (const flag of message.split(" ")) {
        expect(result.stderr).toContain(flag);
      }
    }
    expect(storedTextOf(dir)).toEqual(before);
    expect(errorDocumentSchema.parse(JSON.parse((await run("task", "edit", "APP-1", "--append", "--json")).stderr)).error).toMatchObject({
      code: "invalid_input", details: { argument: "--description" },
    });
  });
});

test("core's value rules for the text-edit flags identify the rejected field", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "text");

    const blankAppend = await run("task", "edit", "APP-1", "--description", " ", "--append", "--json");
    const emptyFind = await run("task", "edit", "APP-1", "--description", "x", "--replacing", "", "--json");
    const blankComment = await run("task", "comment", "edit", "APP-1#1", "--text", "", "--replacing", "text", "--json");

    expect(blankAppend.code).toBe(1);
    expect(blankAppend.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(blankAppend.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["description", "append"] } });
    expect(emptyFind.code).toBe(1);
    expect(emptyFind.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(emptyFind.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["description", "find"] } });
    expect(blankComment.code).toBe(1);
    expect(blankComment.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(blankComment.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: [] } });
  });
});

test("the text-edit flags are limited to the edit commands and listed in their help", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "text");

    expect((await run("task", "create", "APP", "--title", "T", "--append")).code).toBe(1);
    expect((await run("task", "comment", "create", "APP-1", "--text", "x", "--append")).code).toBe(1);

    for (const command of [["task", "edit"], ["project", "edit"], ["label", "edit"], ["task", "comment", "edit"]]) {
      const help = (await run(...command, "--help")).stdout;
      expect(help).toContain("[--append|--replacing <old> [--all]]");
      expect(help).toContain("--append");
    }
  });
});

// --- ACTIVITY

test("task view history opts into shared activity previews and full JSON without writes", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "Inspected task");
    await run("task", "create", "APP", "--title", "Other task");
    await run("task", "edit", "APP-1", "--description", "Full\nrecorded description");
    await run("task", "order", "APP-1", "bottom");
    await run("task", "move", "APP-1", "In Progress");
    const originalComment = "Original comment text\n" + "Previous content. ".repeat(20);
    await run("task", "comment", "create", "APP-1", "--text", originalComment);
    await run("task", "comment", "edit", "APP-1#1", "--text", "Current comment");
    await run("task", "comment", "create", "APP-1", "--text", "Deleted comment");
    await run("task", "comment", "delete", "APP-1#2", "--yes");
    await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    await run("task", "relation", "delete", "APP-1", "APP-2", "--type", "related");
    await run("task", "archive", "APP-1");
    await run("task", "unarchive", "APP-1");

    const events: Array<Activity> = JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"));
    expect(events.find((event) => event.action === "order")).toBeDefined();
    expect(events.find((event) => event.action === "comment_delete")?.changes?.comment).toMatchObject({
      key: "APP-1#2", text: "Deleted comment",
    });
    expect(events.find((event) => event.action === "comment_edit")?.changes?.text).toEqual([
      originalComment, "Current comment",
    ]);

    const ordinaryText = await run("task", "view", "APP-1");
    const ordinaryJson = JSON.parse(await run("task", "view", "APP-1", "--json"));
    expect(ordinaryJson).not.toHaveProperty("activity");
    const historyJson = JSON.parse(await run("task", "view", "app-1", "--history", "--json"));
    expect(historyJson).toEqual({ ...ordinaryJson, activity: events });
    expect(historyJson.comments).toHaveLength(1);
    expect(historyJson.comments[0].text).toBe("Current comment");
    expect(historyJson.comments[0]).not.toHaveProperty("activity");

    const previews = await run("activity", "list", "--task", "APP-1");
    const historyText = await run("task", "view", "APP-1", "--history");
    expect(taskViewContent(historyText).startsWith(taskViewContent(ordinaryText).trimEnd())).toBe(true);
    expect(taskViewContent(historyText).endsWith(previews)).toBe(true);
    expect(historyText).not.toContain(originalComment);
    const commentEdit = events.find((event) => event.action === "comment_edit")!;
    expect(await run("activity", "view", commentEdit.id)).toContain(originalComment);
    expect(JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"))).toEqual(events);
    expect(JSON.parse(await run("task", "view", "APP-1", "--json"))).toEqual(ordinaryJson);
  });
});

test("task view only reads history when requested and includes an empty activity array", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Before recording"], directory)).code).toBe(0);
    const taskId = withTestDb(directory, (db) => {
      db.run("DELETE FROM activity");
      return db.query<{ id: string }, []>("SELECT id FROM task").get()!.id;
    });
    const ordinary = await runZinn(["task", "view", "APP-1", "--json"], directory);
    expect(ordinary.code).toBe(0);
    const requested = await runZinn(["task", "view", "APP-1", "--history", "--json"], directory);
    expect(requested.code).toBe(0);
    expect(JSON.parse(requested.stdout)).toEqual({ ...JSON.parse(ordinary.stdout), activity: [] });
    expect(await runZinn(["task", "view", "APP-1", "--history"], directory)).toEqual(
      await runZinn(["task", "view", "APP-1"], directory),
    );

    await seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-000000000001", entity_id: taskId }]);
    withTestDb(directory, (db) => db.run("UPDATE activity SET changes = 'invalid JSON'"));
    expect(await runZinn(["task", "view", "APP-1", "--json"], directory)).toEqual(ordinary);
    expect((await runZinn(["task", "view", "APP-1"], directory)).code).toBe(0);
    expect((await runZinn(["task", "view", "APP-1", "--history", "--json"], directory)).code).toBe(1);
  });
});

test("task view history orders timestamp ties and preserves full records for only its task", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Current task"], directory)).code).toBe(0);
    const taskId = withTestDb(directory, (db) => {
      db.run("DELETE FROM activity");
      return db.query<{ id: string }, []>("SELECT id FROM task").get()!.id;
    });
    const events = await seedRecordedActivity(directory, [
      { id: "abcdef12-1234-7000-8000-000000000001", entity_id: taskId, created_at: 3, changes: { title: ["Old title", "Current task"], future: { text: "Full\nrecorded payload" } } },
      { id: "fedcba12-1234-7000-8000-000000000001", entity_id: taskId, created_at: 1, action: "order" },
      { id: "abcdef12-1234-7000-8000-000000000002", entity_id: taskId, created_at: 3, action: "archive", actor_email: null },
      { id: "abcdef12-1234-7000-8000-000000000003", entity_id: taskId, entity_type: "label", created_at: 4 },
    ]);
    const viewed = await runZinn(["task", "view", "APP-1", "--history", "--json"], directory);
    expect(viewed.code).toBe(0);
    expect(JSON.parse(viewed.stdout).activity).toEqual([events[2], events[0], events[1]]);
    const previews = await runZinn(["activity", "list", "--task", "APP-1"], directory);
    const text = await runZinn(["task", "view", "APP-1", "--history"], directory);
    expect(text.code).toBe(0);
    expect(taskViewContent(text.stdout).endsWith(previews.stdout)).toBe(true);
    expect(text.stdout).toContain("Old title");
  });
});

test("task view history keeps archived tasks separate from deleted lifetimes with a reused key", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory);
      expect(result.code).toBe(0);
      return result.stdout;
    };
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "Previous lifetime");
    await run("project", "delete", "APP", "--yes");
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "Current lifetime");
    await run("task", "archive", "APP-1");
    const currentTaskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task").get()!.id);
    const allLifetimes: Array<Activity> = JSON.parse(await run("activity", "list", "--task", "APP-1", "--show-deleted", "--json"));
    expect(allLifetimes.some((event) => event.entity_id !== currentTaskId)).toBe(true);
    const viewed = JSON.parse(await run("task", "view", "APP-1", "--history", "--json"));
    expect(viewed.status).toBe("Archived");
    expect(viewed.activity).toEqual(allLifetimes.filter((event) => event.entity_type === "task" && event.entity_id === currentTaskId));
    const text = await run("task", "view", "APP-1", "--history");
    expect(text).not.toContain(currentTaskId);
    expect(text).not.toContain("Previous lifetime");
  });
});

async function seedRecordedActivity(
  directory: string,
  inputs: Array<Pick<Activity, "id"> & Partial<Activity>>,
) {
  expect((await runZinn(["activity", "list", "--json"], directory)).code).toBe(0);
  const events: Array<Activity> = inputs.map((input) => ({
    id: input.id,
    created_at: input.created_at ?? Date.UTC(2026, 9, 8, 10, 30),
    actor_name: input.actor_name === undefined ? "Test Agent" : input.actor_name,
    actor_email: input.actor_email === undefined ? "agent@example.com" : input.actor_email,
    actor_kind: input.actor_kind ?? "agent",
    actor_source: input.actor_source ?? null,
    actor_session_id: input.actor_session_id ?? null,
    actor_thread_id: input.actor_thread_id ?? null,
    actor_agent: input.actor_agent ?? null,
    actor_model: input.actor_model ?? null,
    actor_effort: input.actor_effort ?? null,
    entity_type: input.entity_type ?? "task",
    entity_id: input.entity_id ?? "11111111-1234-7000-8000-123456abcdef",
    action: input.action ?? "edit",
    changes: input.changes ?? null,
  }));
  withTestDb(directory, (db) => {
    const insert = db.query("INSERT INTO activity (id, created_at, actor_name, actor_email, actor_kind, actor_source, actor_session_id, actor_thread_id, actor_agent, actor_model, actor_effort, entity_type, entity_id, action, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const event of events) {
      insert.run(event.id, event.created_at, event.actor_name, event.actor_email, event.actor_kind,
        event.actor_source, event.actor_session_id, event.actor_thread_id, event.actor_agent, event.actor_model, event.actor_effort,
        event.entity_type, event.entity_id, event.action,
        event.changes === null ? null : JSON.stringify(event.changes));
    }
  });
  return events;
}

test("activity empty lists and unrecoverable task histories return empty results", async () => {
  await withIsolatedZinnDir(async (directory) => {
    for (const args of [["activity", "list"], ["activity", "list", "--task", "gone-2", "--show-deleted"], ["activity", "list", "--task-id", "ffffffff-ffff-7fff-8fff-ffffffffffff"]]) {
      const text = await runZinn(args, directory);
      expect(text).toEqual({ code: 0, stdout: "", stderr: "" });
      const json = await runZinn([...args, "--json"], directory);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([]);
    }
  });
});

test("activity task-key selection refuses missing current tasks with explicit deleted-history guidance", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Deleted task")).code).toBe(0);
    expect((await run("task", "delete", "APP-1", "--yes")).code).toBe(0);
    const before = withTestDb(directory, (db) => db.query("SELECT * FROM activity ORDER BY id").all());
    for (const key of ["app-1", "APP-99", "GONE-1"]) {
      const result = await run("activity", "list", "--task", key, "--json");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const failure = JSON.parse(result.stderr).error;
      expect(failure.code).toBe("not_found");
      expect(failure.details).toMatchObject({ entity: "task", key: key.toUpperCase(), argument: "--task" });
      expect(failure.help).toContain("--show-deleted");
      expect(failure.help).toContain(key);
      const text = await run("activity", "list", "--task", key);
      expect(text.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain("--show-deleted");
    }
    const history = await run("activity", "list", "--task", "APP-1", "--show-deleted", "--json");
    expect(history.code).toBe(0);
    expect(JSON.parse(history.stdout).map((event: Activity) => event.action)).toEqual(["delete", "create"]);
    expect(withTestDb(directory, (db) => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(before);
    withTestDb(directory, (db) => db.run("ALTER TABLE task RENAME TO unavailable_task"));
    const broken = await run("activity", "list", "--task", "APP-1", "--json");
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.stderr).error.code).not.toBe("not_found");
    expect(broken.stderr).not.toContain("--show-deleted");
  });
});

test("activity exact task IDs retain identity, status and original project deletion under limits", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "Original task");
    await run("task", "edit", "APP-1", "--title", "Changed task");
    const firstHistory = JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"));
    const first = { id: firstHistory[0].entity_id as string };
    await run("project", "delete", "APP", "--yes");
    const deletion = JSON.parse(await run("activity", "list", "--json")).find((event: Activity) => event.entity_type === "project" && event.action === "delete");
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "New task");
    const secondHistory = JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"));
    const second = { id: secondHistory[0].entity_id as string };
    for (const [taskId, expected] of [[first.id, [deletion, ...firstHistory]], [second.id, secondHistory]] as const) {
      for (const spelling of [taskId, taskId.toUpperCase(), taskId.replaceAll("-", ""), taskId.replaceAll("-", "").toUpperCase()]) {
        expect(JSON.parse(await run("activity", "list", "--task-id", spelling, "--json"))).toEqual(expected);
      }
      expect(JSON.parse(await run("activity", "list", "--task-id", taskId, "--limit", "1", "--json"))).toEqual(expected.slice(0, 1));
    }
    const boundary = await run("activity", "list", "--task-id", first.id, "--limit", "1");
    expect(boundary).toContain("project APP");
    expect(boundary).toContain("deleted");
    expect(boundary).toContain("APP-1");
    expect(boundary).toContain(first.id);
    expect(boundary).not.toContain(second.id);
    const active = await run("activity", "list", "--task-id", second.id, "--limit", "1");
    expect(active).toContain(second.id);
    expect(active).toContain("current");
    await run("task", "archive", "APP-1");
    const archived = await run("activity", "list", "--task-id", second.id, "--limit", "1");
    expect(archived).toContain(second.id);
    expect(archived).toContain("[archived]");
    expect(await run("activity", "list", "--task", "APP-1")).not.toContain("[archived]");
    const archivedEvents = JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"));
    expect(archivedEvents.every((event: Activity) => event.entity_id === second.id)).toBe(true);
    expect(JSON.parse(await run("activity", "list", "--task-id", first.id, "--session", "missing", "--limit", "1", "--json"))).toEqual([]);
    await run("task", "delete", "APP-1", "--yes");
    const deleted = await run("activity", "list", "--task-id", second.id, "--limit", "1");
    expect(deleted).toContain(second.id);
    expect(deleted).toContain("deleted");
    expect(deleted).not.toContain(first.id);
  });
});

test("activity exact task IDs preserve empty histories and conjunctive session/thread filtering", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const taskId = "abcdef12-1234-7000-8000-123456abcdef";
    const events = await seedRecordedActivity(directory, [
      { id: "11111111-1111-7111-8111-111111111111", entity_id: taskId, created_at: 1, actor_session_id: "Session/one", actor_thread_id: "Thread/one", changes: { future: { text: "Full\ntext", values: [null, 2] } } },
      { id: "11111111-2111-7111-8111-111111111111", entity_id: taskId, created_at: 2, actor_session_id: "Session/one", actor_thread_id: "Thread/two" },
      { id: "11111111-3111-7111-8111-111111111111", entity_id: taskId, created_at: 1, actor_session_id: "Session/one", actor_thread_id: "Thread/one" },
      { id: "11111111-4111-7111-8111-111111111111", entity_id: "abcdef12-1234-7000-8000-123456abcdee", created_at: 3 },
    ]);
    const before = withTestDb(directory, (db) => db.query("SELECT * FROM activity ORDER BY id").all());
    const query = (...flags: Array<string>) => runZinn(["activity", "list", "--task-id", taskId, ...flags, "--json"], directory);
    expect(JSON.parse((await query()).stdout)).toEqual([events[1], events[2], events[0]]);
    expect(JSON.parse((await query("--session", "Session/one", "--thread", "Thread/one", "--limit", "1")).stdout)).toEqual([events[2]]);
    expect(JSON.parse((await query("--session", "Session/one", "--thread", "Thread/one")).stdout)).toEqual([events[2], events[0]]);
    expect(JSON.parse((await query("--session", "session/one")).stdout)).toEqual([]);
    expect(withTestDb(directory, (db) => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(before);
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "No recorded history"], directory)).code).toBe(0);
    const emptyId = withTestDb(directory, (db) => {
      const id = db.query<{ id: string }, []>("SELECT id FROM task").get()!.id;
      db.query("DELETE FROM activity WHERE entity_type = 'task' AND entity_id = ?").run(id);
      return id;
    });
    for (const selector of [["--task", "APP-1"], ["--task-id", emptyId]]) {
      expect(await runZinn(["activity", "list", ...selector], directory)).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(JSON.parse((await runZinn(["activity", "list", ...selector, "--json"], directory)).stdout)).toEqual([]);
    }
  });
});

test("activity JSON preserves full matching records, parsed payloads and deterministic ordering", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const events = await seedRecordedActivity(directory, [
      { id: "11111111-1234-7000-8000-123456abcde1", created_at: 1, entity_type: "project", action: "create", changes: { key: "OLD", name: "Old project", columns: [] } },
      { id: "11111111-1234-7000-8000-123456abcde2", created_at: 2, entity_type: "column", action: "order", actor_name: null, actor_source: "adapter/test", actor_session_id: "session/1", actor_thread_id: "thread/2", actor_agent: "general", actor_model: "vendor/model", actor_effort: "medium" },
      { id: "11111111-1234-7000-8000-123456abcde3", created_at: 2, entity_type: "label", action: "delete", actor_email: null, changes: { name: "Old label", description: "Full\ntext", future: { values: [1, null] } } },
    ]);
    const listed = await runZinn(["activity", "list", "--json"], directory);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([events[2], events[1], events[0]]);
    expect(JSON.parse((await runZinn(["activity", "list", "--limit", "1", "--json"], directory)).stdout)).toEqual([events[2]]);
    expect(JSON.parse((await runZinn(["activity", "list", "--limit", String(Number.MAX_SAFE_INTEGER), "--json"], directory)).stdout)).toHaveLength(3);
    for (const event of events) {
      const viewed = await runZinn(["activity", "view", event.id, "--json"], directory);
      expect(viewed.code).toBe(0);
      expect(JSON.parse(viewed.stdout)).toEqual(event);
    }
    const text = (await runZinn(["activity", "list"], directory)).stdout;
    expect(text).toContain("order");
    expect(text).toContain("column");
    expect(text).toContain("Entity ID: 11111111-1234-7000-8000-123456abcdef");
    const identityOf = (name: string) => text.split("\n").find((line) => line.includes(name))!.split(" · ")[0];
    expect(identityOf("project OLD")).toContain("deleted");
    expect(identityOf("label Old label")).toContain("deleted");
    expect(identityOf("column 1111")).toContain("deleted");
  });
});

test("project activity filters retain original member events and project lifetimes through the CLI", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory, { ZINN_SESSION_ID: "project/run", ZINN_THREAD_ID: "project/thread" });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const list = async (...flags: Array<string>): Promise<Array<Activity>> => JSON.parse(await run("activity", "list", ...flags, "--json"));
    await run("project", "create", "APP");
    const firstProject = { id: (await list())[0]!.entity_id };
    await run("project", "create", "OUT");
    await run("project", "column", "create", "APP", "Extra");
    await run("task", "create", "APP", "--title", "Deleted before project");
    await run("task", "create", "APP", "--title", "Archived member");
    await run("task", "create", "OUT", "--title", "Outside");
    await run("task", "comment", "create", "APP-1", "--text", "Preserved note");
    await run("label", "create", "Attached");
    await run("task", "edit", "APP-1", "--add-label", "Attached");
    await run("label", "delete", "Attached", "--yes");
    await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    await run("task", "relation", "create", "APP-1", "OUT-1", "--type", "related");
    await run("task", "archive", "APP-2");
    const memberIds = withTestDb(directory, (db) => new Set([
      firstProject.id,
      ...db.query<{ id: string }, [string]>("SELECT id FROM task WHERE project_id = ?").all(firstProject.id).map(row => row.id),
      ...db.query<{ id: string }, [string]>("SELECT id FROM project_column WHERE project_id = ?").all(firstProject.id).map(row => row.id),
    ]));
    await run("task", "delete", "APP-1", "--yes");
    const beforeDeletion = (await list()).filter(event => memberIds.has(event.entity_id));
    expect(await list("--project", "app")).toEqual(beforeDeletion);
    expect(beforeDeletion.filter(event => event.action === "relation_create")).toHaveLength(3);
    expect(beforeDeletion.some(event => event.entity_type === "label")).toBe(false);
    expect(beforeDeletion.some(event => event.action === "comment_create")).toBe(true);
    const text = await run("activity", "list", "--project", "APP");
    const displayedIds = text.split("\n").map(line => line.match(/^([0-9a-f-]{8,})\s/)?.[1]).filter(Boolean);
    expect(displayedIds).toHaveLength(beforeDeletion.length);
    expect(displayedIds.map(prefix => beforeDeletion.find(event => event.id.startsWith(prefix!))?.id))
      .toEqual(beforeDeletion.map(event => event.id));
    await run("project", "delete", "APP", "--yes");
    const firstLifetime = (await list()).filter(event => memberIds.has(event.entity_id));
    expect(await list("--project", "APP", "--show-deleted")).toEqual(firstLifetime);
    const aggregate = firstLifetime.find(event => event.entity_type === "project" && event.action === "delete")!;
    expect(aggregate.changes!.tasks).toHaveLength(1);
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "New lifetime");
    const current = await list("--task", "APP-1");
    expect((await list("--project", "APP")).filter(event => event.entity_type === "task")).toEqual(current);
    const all = await list("--project", "APP", "--show-deleted");
    expect(all).toEqual([...await list("--project", "APP"), ...firstLifetime]);
    for (const id of [firstProject.id, firstProject.id.toUpperCase(), firstProject.id.replaceAll("-", ""), firstProject.id.replaceAll("-", "").toUpperCase()]) {
      expect(await list("--project-id", id)).toEqual(firstLifetime);
    }
    expect(await list("--project", "APP", "--show-deleted", "--session", "project/run", "--thread", "project/thread", "--limit", "2")).toEqual(all.slice(0, 2));
    expect(await list("--project", "APP", "--session", "Project/run")).toEqual([]);
    const limited = await run("activity", "list", "--project", "APP", "--show-deleted", "--limit", "1");
    expect(limited).toContain(current[0]!.entity_id);
    const deletionText = await run("activity", "list", "--project-id", firstProject.id, "--limit", "1");
    expect(deletionText).toContain("APP");
    expect(deletionText).toContain((aggregate.changes!.tasks as Array<{ id: string }>)[0]!.id);
    const beforeReads = withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all());
    for (const flags of [["--project", "UNKNOWN", "--show-deleted"], ["--project-id", "ffffffff-ffff-7fff-8fff-ffffffffffff"]]) {
      expect(await list(...flags)).toEqual([]);
      expect(await run("activity", "list", ...flags)).toBe("");
    }
    expect(withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(beforeReads);
  });
});

test("project activity refuses missing current projects and invalid selectors without changing data", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    const id = "abcdef12-1234-7000-8000-123456abcdef";
    const selector = routes.activity.list.input.constraints.find(constraint => constraint.kind === "exclusive")!;
    const values: Record<string, string> = { project: "APP", "project-id": id, task: "APP-1", "task-id": id };
    const invalid: Array<Array<string>> = [
      ["--project"], ["--project", ""], ["--project", "9APP"], ["--project", "APP-1"],
      ["--project", "APP", "--project", "OUT"], ["--project-id", id, "--project-id", id],
      ["--project-id"], ["--project-id", "abcdef12"], ["--project-id", id.slice(0, -1)],
      ["--project-id", "abcd-ef12123470008000123456abcdef"],
      ["--project-id", id, "--show-deleted"],
      ["--project", "APP", "--show-deleted", "--show-deleted"], ["--show-deleted"],
    ];
    const names = selector.members.map(member => member.slice("option:".length));
    for (const [index, left] of names.entries()) {
      for (const right of names.slice(index + 1)) {
        invalid.push([`--${left}`, values[left]!, `--${right}`, values[right]!]);
      }
    }
    const before = withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all());
    for (const flags of invalid) {
      const result = await runZinn(["activity", "list", ...flags, "--json"], directory);
      expect(result.code, flags.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    }
    const missing = await runZinn(["activity", "list", "--project", "gone", "--json"], directory);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(JSON.parse(missing.stderr).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "GONE", argument: "--project" } });
    expect(JSON.parse(missing.stderr).error.help).toContain("--show-deleted");
    expect(JSON.parse(missing.stderr).error.help).toContain("gone");
    expect(withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(before);
    withTestDb(directory, db => db.run("ALTER TABLE project RENAME TO unavailable_project"));
    const broken = await runZinn(["activity", "list", "--project", "APP", "--json"], directory);
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.stderr).error.code).not.toBe("not_found");
    expect(broken.stderr).not.toContain("--show-deleted");
  });
});

test("limited project activity keeps deleted task and column names when identity snapshots are filtered out", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (args: Array<string>, session = "setup") => {
      const result = await runZinn(args, directory, { ZINN_SESSION_ID: session });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    await run(["project", "create", "APP"]);
    const projectId = JSON.parse(await run(["activity", "list", "--json"]))[0].entity_id;
    await run(["project", "column", "create", "APP", "Extra"]);
    await run(["task", "create", "APP", "--title", "Original"]);
    const taskId = JSON.parse(await run(["activity", "list", "--task", "APP-1", "--json"]))[0].entity_id;
    await run(["task", "edit", "APP-1", "--title", "Edited"], "task/edit");
    await run(["project", "edit", "APP", "--name", "Renamed"], "project/edit");
    await run(["project", "column", "edit", "APP", "Extra", "--name", "Renamed column"], "column/edit");
    await run(["task", "delete", "APP-1", "--yes"]);
    await run(["project", "delete", "APP", "--yes"]);
    await run(["project", "create", "APP"]);
    await run(["task", "create", "APP", "--title", "Reused key"]);
    const flags = ["activity", "list", "--project-id", projectId, "--limit", "1", "--session"];
    const taskText = await run([...flags, "task/edit"]);
    expect(taskText).toContain("APP-1");
    expect(taskText).toContain(taskId);
    expect(taskText).toContain("deleted");
    const taskEvents = JSON.parse(await run([...flags, "task/edit", "--json"]));
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]).toMatchObject({ entity_id: taskId, action: "edit", changes: { title: ["Original", "Edited"] } });
    expect(await run([...flags, "project/edit"])).toContain("project APP [deleted]");
    expect(await run([...flags, "column/edit"])).toContain("column Renamed column [deleted]");
    const help = await run(["activity", "list", "--help"]);
    for (const flag of ["--project", "--project-id", "--task", "--task-id", "--show-deleted"]) {
      expect(help).toContain(flag);
    }
  });
});

test("project activity navigation scans history a bounded number of times for many deleted tasks", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const result = await runProcessAsync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { spyOn } from "bun:test";
      import { activity, project, task } from ${JSON.stringify(join(import.meta.dir, "../core/index.ts"))};
      import * as dbActivity from ${JSON.stringify(join(import.meta.dir, "../core/src/db/activity.ts"))};
      import { presentActivities } from ${JSON.stringify(join(import.meta.dir, "src/presentation/activity-presentation.ts"))};
      const actor = { name: "Test", email: null, kind: "human" };
      const app = project.create({ key: "APP" }, actor);
      const first = task.create({ project_id: app.id, title: "First" }, actor);
      task.edit({ taskKey: first.key, title: "Edited" }, { ...actor, sessionId: "selected" });
      task.delete(first.key, actor);
      for (let index = 0; index < 100; index++) {
        const item = task.create({ project_id: app.id, title: "Deleted " + index }, actor);
        task.delete(item.key, actor);
      }
      const retained = task.create({ project_id: app.id, title: "Retained until project deletion" }, actor);
      project.delete("APP", actor);
      const currentProject = project.create({ key: "APP" }, actor);
      const current = task.create({ project_id: currentProject.id, title: "Reused key" }, actor);
      task.archive(current.key, actor);
      const selected = activity.getAll({ projectId: app.id, sessionId: "selected", limit: 1 });
      const deletion = activity.getAll({ projectId: app.id, limit: 1 });
      const globalHistory = spyOn(dbActivity, "getAll");
      const deletionHistory = spyOn(dbActivity, "getTaskDeletionEvents");
      const maxFullHistoryScans = 2;
      const checkScans = () => {
        assert.ok(globalHistory.mock.calls.length <= maxFullHistoryScans);
        assert.ok(deletionHistory.mock.calls.length <= 1,
          "Deletion history must not be reread for each historical task key");
        globalHistory.mockClear();
        deletionHistory.mockClear();
      };
      const [historical] = presentActivities(selected, { projectId: app.id });
      assert.equal(historical.navigation.name, first.key);
      assert.equal(historical.navigation.status, "deleted");
      assert.equal(historical.navigation.distinguishesTaskId, true);
      checkScans();
      const [aggregate] = presentActivities(deletion, { projectId: app.id });
      assert.deepEqual(aggregate.removedTasks, [{ id: retained.id, key: retained.key,
        title: retained.title, status: "deleted" }]);
      checkScans();
      const currentEvents = activity.getAll({ projectKey: "APP", limit: 1 });
      globalHistory.mockClear();
      const [archived] = presentActivities(currentEvents, { projectKey: "APP" });
      assert.equal(archived.navigation.name, current.key);
      assert.equal(archived.navigation.status, "archived");
      checkScans();
    `], { cwd: directory, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory } });
    expect(result.code, result.stderr).toBe(0);
  });
});

test("activity returns all events by default and limits only after selecting matches", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const events = await seedRecordedActivity(directory, Array.from({ length: 55 }, (_, index) => ({
      id: `11111111-1234-7000-8000-${String(index).padStart(12, "0")}`,
      created_at: index,
    })));
    expect(JSON.parse((await runZinn(["activity", "list", "--json"], directory)).stdout)).toEqual(events.toReversed());
    expect(JSON.parse((await runZinn(["activity", "list", "--limit", "2", "--json"], directory)).stdout)).toEqual(events.toReversed().slice(0, 2));
  });
});

test("activity task-filtered prefixes remain globally unique even outside the filter and limit", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Current task"], directory)).code).toBe(0);
    const taskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task").get()!.id);
    const first = "abcdef12-1234-7000-8000-000000000001";
    const second = "abcdef12-1234-7000-8000-000000000002";
    await seedRecordedActivity(directory, [
      { id: first, created_at: Date.now() + 1000, entity_id: taskId },
      { id: second, created_at: Date.now() + 2000, entity_type: "label" },
    ]);
    const filtered = await runZinn(["activity", "list", "--task", "app-1", "--limit", "1"], directory);
    expect(filtered.code).toBe(0);
    expect(filtered.stdout.split(" | ")[0]).toBe(first);
    expect(filtered.stdout).toContain("APP-1 · edited");
    expect(filtered.stdout).not.toContain("[current]");
    expect(filtered.stdout).not.toContain(second);
    const ambiguous = await runZinn(["activity", "view", "abcdef12", "--json"], directory);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stdout).toBe("");
    const failure = errorDocumentSchema.parse(JSON.parse(ambiguous.stderr)).error;
    expect(failure).toMatchObject({ code: "conflict", details: { reason: "ambiguous_reference", matchCount: 2, candidateIds: expect.arrayContaining([first, second]) } });
    expect(failure.message).toContain(first);
    expect(failure.message).toContain(second);
  });
});

test("activity view accepts normalized IDs and reports malformed, short and missing IDs distinctly", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const id = "abcdef12-1234-7000-8000-123456abcdef";
    const [event] = await seedRecordedActivity(directory, [{ id }]);
    for (const input of [id, id.toUpperCase(), id.replaceAll("-", ""), "ABCDEF12", "ABCDEF12-1", "ABCDEF121"]) {
      const result = await runZinn(["activity", "view", input, "--json"], directory);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(event);
    }
    for (const [input, expected] of [
      ["abcdef1", { code: "invalid_input", details: { field: [] } }],
      ["abcd-ef12", { code: "invalid_input", details: { field: [] } }],
      ["ffffffff", { code: "not_found", details: { entity: "activity", key: "ffffffff" } }],
    ] as const) {
      const result = await runZinn(["activity", "view", input, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
    }
  });
});

test("activity rejects unsupported, repeated and malformed command arguments without writes", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const [event] = await seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-123456abcdef" }]);
    const before = withTestDb(directory, (db) => db.query("SELECT * FROM activity").all());
    const invalid = [
      ["list", "APP-1"], ["list", "--project", "APP-1"],
      ["list", "--task", "APP-1", "--task", "APP-2"],
      ["list", "--limit", "1", "--limit", "2"], ["list", "--task", "APP-0"],
      ["list", "--session", "first", "--session", "second"],
      ["list", "--thread", "first", "--thread", "second"],
      ["list", "--task-id", event!.entity_id, "--task-id", event!.entity_id],
      ["list", "--task", "APP-1", "--show-deleted", "--show-deleted"],
      ["list", "--task", "APP-1", "--task-id", event!.entity_id],
      ["list", "--show-deleted"], ["list", "--task-id", event!.entity_id, "--show-deleted"],
      ["list", "--task-id"], ["list", "--task-id", ""],
      ["list", "--task-id", "abcdef12"], ["list", "--task-id", event!.id.slice(0, -1)],
      ["list", "--task-id", "abcd-ef12123470008000123456abcdef"],
      ["list", "--task", "APP-1", "--show-deleted=true"],
      ["list", "--session", ""], ["list", "--thread", ""],
      ["view"], ["view", event!.id, "extra"], ["view", event!.id, "--task", "APP-1"],
      ["view", event!.id, "--session", "session"],
    ];
    for (const args of invalid) {
      const result = await runZinn(["activity", ...args, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.message.length).toBeGreaterThan(0);
    }
    for (const [limit, details] of [
      ...["0", "-1", "1.5", "1e2", "01", " 2", "Infinity", "99999999999999999"]
        .map((limit) => [limit, { argument: "--limit" }] as const),
      ["9007199254740992", { field: ["limit"] }],
    ] as const) {
      const result = await runZinn(["activity", "list", `--limit=${limit}`, "--json"], directory);
      expect(result.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "invalid_input", details });
    }
    expect(withTestDb(directory, (db) => db.query("SELECT * FROM activity").all())).toEqual(before);
  });
});

test("session activity filters return only committed changes and compose with thread, task and limit", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (args: Array<string>, env: Record<string, string> = {}) => runZinnAs(args, directory, env);
    const events = async (...flags: Array<string>): Promise<Array<Activity>> => {
      const result = await run(["activity", "list", ...flags, "--json"]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout);
    };
    const first = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "Conversation/A" };
    const second = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "Conversation/B" };
    const child = {
      CODEX_SESSION_ID: "Conversation/C", CODEX_THREAD_ID: "Child/1",
      ZINN_AGENT: "worker", ZINN_MODEL: "vendor/model", ZINN_EFFORT: "low",
    };
    const parent = { CODEX_SESSION_ID: "Conversation/C", CODEX_THREAD_ID: "Conversation/C" };
    expect((await run(["project", "create", "RUN"], first)).code).toBe(0);
    expect((await run(["task", "create", "RUN", "--title", "First"], first)).code).toBe(0);
    expect((await run(["task", "edit", "RUN-1", "--title", "Changed"], first)).code).toBe(0);
    expect((await run(["task", "create", "RUN", "--title", "Second"], second)).code).toBe(0);
    expect((await run(["task", "create", "RUN", "--title", "Child"], child)).code).toBe(0);
    expect((await run(["task", "edit", "RUN-2", "--title", "Parent update"], parent)).code).toBe(0);

    const session = await events("--session", "Conversation/A");
    expect(session.map((event) => [event.entity_type, event.action])).toEqual([
      ["task", "edit"], ["task", "create"], ["project", "create"],
    ]);
    expect(session.every((event) => event.actor_session_id === "Conversation/A" && event.actor_thread_id === null)).toBe(true);
    expect(await events("--session", "Conversation/A", "--task", "run-1", "--limit", "1")).toEqual([session[0]!]);
    const childEvents = await events("--thread", "Child/1");
    expect(childEvents).toHaveLength(1);
    expect(childEvents[0]).toMatchObject({ actor_session_id: "Conversation/C", actor_thread_id: "Child/1", changes: { title: "Child" } });
    expect(await events("--session", "Conversation/C", "--thread", "Child/1")).toEqual(childEvents);
    expect(await events("--session", "Conversation/C")).toHaveLength(2);
    expect(await events("--thread", "Conversation/C")).toHaveLength(1);

    const historicalId = "abcdef12-1234-7000-8000-123456abcde1";
    await seedRecordedActivity(directory, [{ id: historicalId, actor_name: "1", entity_id: session[0]!.entity_id }]);
    expect((await events()).some((event) => event.id === historicalId)).toBe(true);
    expect(await events("--session", "Conversation/A")).toEqual(session);
    const before = await events();
    expect((await run(["task", "edit", "RUN-1", "--title", "Changed"], first)).code).toBe(0);
    expect((await run(["task", "move", "RUN-1", "Missing"], first)).code).toBe(1);
    expect(await events()).toEqual(before);

    for (const flags of [
      ["--session", "conversation/A"], ["--session", "Conversation"],
      ["--session", " Conversation/A"], ["--thread", "Child"],
      ["--session", "Conversation/A", "--thread", "Child/1"],
    ]) {
      expect(await events(...flags)).toEqual([]);
      expect(await run(["activity", "list", ...flags])).toEqual({ code: 0, stdout: "", stderr: "" });
    }

    const view = await run(["activity", "view", childEvents[0]!.id]);
    expect(view.code).toBe(0);
    for (const detail of ["Source: env:CODEX_THREAD_ID", "Session: Conversation/C", "Thread: Child/1", "Agent: worker", "Model: vendor/model", "Effort: low"]) {
      expect(view.stdout).toContain(detail);
    }
    const historical = await run(["activity", "view", historicalId]);
    expect(historical.code).toBe(0);
    for (const field of ["Source", "Session", "Thread", "Agent", "Model", "Effort"]) {
      expect(historical.stdout).toContain(`${field}: null`);
    }
  });
});

test("activity recovers deleted and reused task lifetimes, retaining the original project deletion", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Old lifetime")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Unrelated")).code).toBe(0);
    const oldTaskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task WHERE number = 1").get()!.id);
    expect((await run("task", "archive", "APP-1")).code).toBe(0);
    const archivedEvents: Array<Activity> = JSON.parse((await run("activity", "list", "--task", "APP-1", "--json")).stdout);
    const archiveEvent = archivedEvents.find((event) => event.action === "archive")!;
    expect((await run("activity", "list", "--task", "APP-1")).stdout).not.toContain("[archived]");
    expect((await run("activity", "view", archiveEvent.id)).stdout).toContain("[archived]");
    expect((await run("project", "delete", "APP", "--yes")).code).toBe(0);
    const deletion = JSON.parse((await run("activity", "list", "--json")).stdout).find((event: Activity) => event.entity_type === "project" && event.action === "delete");
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "New lifetime")).code).toBe(0);
    const newTaskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task WHERE number = 1").get()!.id);
    const current = JSON.parse((await run("activity", "list", "--task", "APP-1", "--json")).stdout);
    expect(current).toHaveLength(1);
    expect(current[0].entity_id).toBe(newTaskId);
    const events: Array<Activity> = JSON.parse((await run("activity", "list", "--task", "app-1", "--show-deleted", "--json")).stdout);
    expect(events).toHaveLength(4);
    expect(events.find((event) => event.id === deletion.id)).toEqual(deletion);
    expect(new Set(events.filter((event) => event.entity_type === "task").map((event) => event.entity_id))).toEqual(new Set([oldTaskId, newTaskId]));
    const text = (await run("activity", "list", "--task", "APP-1", "--show-deleted")).stdout;
    const projectDeletionRow = text.split("\n").find((line) => line.includes("project APP"))!;
    expect(projectDeletionRow.split(" · ")[0]).toContain("deleted");
    expect(text).toContain(newTaskId);
    expect(text).toContain(`removed APP-1 (${oldTaskId})`);
    const limited = (await run("activity", "list", "--task", "APP-1", "--show-deleted", "--limit", "1")).stdout;
    expect(limited.split("\n")[0]!.split(" · ")[0]).not.toContain("deleted");
    expect(limited).toContain(newTaskId);
    expect(limited).not.toContain(oldTaskId);
    expect(JSON.parse((await run("activity", "list", "--task", "APP-99", "--show-deleted", "--json")).stdout)).toEqual([]);
    const viewedDeletion = (await run("activity", "view", deletion.id)).stdout;
    expect(viewedDeletion).toContain(oldTaskId);
    expect(viewedDeletion.split("\n")[0]).toContain("deleted");
  });
});

test("activity marks deleted lifetimes of a reused key and keeps every task ID", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    const taskIds: Array<string> = [];
    for (const title of ["First lifetime", "Second lifetime", "Third lifetime"]) {
      if (taskIds.length > 0) {
        expect((await run("project", "delete", "APP", "--yes")).code).toBe(0);
      }
      expect((await run("project", "create", "APP")).code).toBe(0);
      expect((await run("task", "create", "APP", "--title", title)).code).toBe(0);
      taskIds.push(withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task WHERE number = 1").get()!.id));
    }
    expect((await run("task", "archive", "APP-1")).code).toBe(0);
    const [firstId, secondId, archivedId] = taskIds as [string, string, string];
    const events: Array<Activity> = JSON.parse((await run("activity", "list", "--task", "APP-1", "--show-deleted", "--json")).stdout);
    expect(new Set(events.filter((event) => event.entity_type === "task").map((event) => event.entity_id))).toEqual(new Set(taskIds));

    // A task row's ID line follows the row; project rows list removed tasks instead.
    const lines = (await run("activity", "list", "--task", "APP-1", "--show-deleted")).stdout.split("\n");
    const taskRowIds = (isDeleted: boolean) =>
      new Set(lines.flatMap((line, index) => {
        const identity = line.split(" · ")[0]!;
        const isTaskRow = identity.includes("APP-1") && !identity.includes("project APP");
        return isTaskRow && identity.includes("deleted") === isDeleted
          ? taskIds.filter((id) => lines[index + 1]?.includes(id))
          : [];
      }));
    expect(taskRowIds(true)).toEqual(new Set([firstId, secondId]));
    expect(taskRowIds(false)).toEqual(new Set([archivedId]));
  });
});

test("activity finds explicit task deletions and deletion-only historical snapshots", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Delete me"], directory)).code).toBe(0);
    expect((await runZinn(["task", "delete", "APP-1", "--yes"], directory)).code).toBe(0);
    const explicit = await runZinn(["activity", "list", "--task", "APP-1", "--show-deleted"], directory);
    expect(explicit.code).toBe(0);
    const explicitRows = explicit.stdout.trimEnd().split("\n");
    expect(explicitRows).toHaveLength(2);
    expect(explicitRows.every((row) => row.split(" · ")[0]!.includes("deleted"))).toBe(true);
    expect(explicit.stdout).toContain("Delete me");
    const [snapshot] = await seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-123456abcdef", entity_type: "project", action: "delete",
      changes: { key: "GONE", tasks: [{ id: "old-task", key: "GONE-2", title: "Snapshot only" }] } }]);
    expect(JSON.parse((await runZinn(["activity", "list", "--task", "gone-2", "--show-deleted", "--json"], directory)).stdout)).toEqual([snapshot]);
    expect((await runZinn(["activity", "list", "--task", "GONE-2", "--show-deleted"], directory)).stdout).toContain("removed GONE-2 (old-task)");
  });
});

test("activity retains each relation event and uses current names only for navigation", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "First")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Second")).code).toBe(0);
    expect((await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related")).code).toBe(0);
    expect((await run("label", "create", "Before")).code).toBe(0);
    expect((await run("label", "edit", "Before", "--name", "Now")).code).toBe(0);
    const events: Array<Activity> = JSON.parse((await run("activity", "list", "--json")).stdout);
    const relations = events.filter((event) => event.action === "relation_create");
    expect(relations).toHaveLength(2);
    expect(relations[0]!.id).not.toBe(relations[1]!.id);
    expect(relations[0]!.changes).toEqual(relations[1]!.changes);
    const text = (await run("activity", "list")).stdout;
    expect(text.match(/added relation/g)).toHaveLength(2);
    expect(text).toContain("source: APP-1");
    expect(text).toContain("target: APP-2");
    const labelCreate = events.find((event) => event.entity_type === "label" && event.action === "create")!;
    const view = (await run("activity", "view", labelCreate.id)).stdout;
    expect(view).toContain("label Now [current]");
    expect(view).toContain("name:\nBefore");
    expect(JSON.parse((await run("activity", "view", labelCreate.id, "--json")).stdout)).toEqual(labelCreate);
  });
});

test("activity views preserve recorded text, actor/entity identity, unknown fields and local offsets", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const oldText = "  Before\n\tSecond line\n";
    const newText = "  After\r\n\tFinal line  ";
    const id = "abcdef12-1234-7000-8000-123456abcdef";
    const [event] = await seedRecordedActivity(directory, [{ id,
      changes: { title: ["Old title", "New title"], description: [oldText, newText], future: { text: "Unknown\ntext", values: [null, 2] } } }]);
    const view = await runZinn(["activity", "view", "abcdef12"], directory, { TZ: "Europe/Berlin" });
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
    const listed = (await runZinn(["activity", "list"], directory)).stdout;
    expect(listed).toContain("description changed");
    expect(listed).not.toContain(oldText);
    expect(JSON.parse((await runZinn(["activity", "view", id, "--json"], directory)).stdout)).toEqual(event);
    const [commentEvent] = await seedRecordedActivity(directory, [{ id: "fedcba98-1234-7000-8000-123456abcdef", action: "comment_create",
      changes: { comment: { id: "old-comment", key: "APP-1#1", text: oldText } } }]);
    expect((await runZinn(["activity", "view", commentEvent!.id], directory)).stdout).toContain(oldText);
  });
});

test.each([0, 9])("activity commands read schema version %i under the existing policy without writes", async (version) => {
  await withIsolatedZinnDir(async (directory) => {
    const [event] = await seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-123456abcdef", action: "delete",
      changes: { key: "GONE-1", title: "Deleted" } }]);
    withTestDb(directory, (db) => db.run(`PRAGMA user_version = ${version}`));
    const snapshot = () => withTestDb(directory, (db) => ({
      schema: db.query("SELECT * FROM sqlite_schema ORDER BY name").all(),
      events: db.query("SELECT * FROM activity").all(),
      version: db.query("PRAGMA user_version").get(),
    }));
    const before = snapshot();
    if (version === 0) {
      const refused = await runZinn(["activity", "list", "--json"], directory);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(JSON.parse(refused.stderr).error.message).toContain("--allow-legacy-read");
    }
    const flags = version === 0 ? ["--allow-legacy-read"] : [];
    for (const args of [["list"], ["list", "--project", "GONE", "--show-deleted"], ["list", "--project-id", event!.entity_id], ["list", "--task", "GONE-1", "--show-deleted"], ["list", "--task-id", event!.entity_id], ["view", event!.id]]) {
      for (const mode of [[], ["--json"]]) {
        const result = await runZinn(["activity", ...args, ...flags, ...mode], directory);
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
