import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import packageJson from "../package.json";
import { errorDocumentSchema } from "../src/errors";
import { parseRoutes } from "../src/routes/router";
import { routes } from "../src/routes/routes";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

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
    const taskCommands = parseRoutes(routes)
      .filter(route => route.command.startsWith("task ") && route.command.split(" ").length === 2)
      .map(route => route.command.split(" ")[1]);
    expect(longHelp.stdout).toContain(`task {${taskCommands.join("|")}}`);
    expect(longHelp.stdout).toContain("task comment {create|list|view|edit|delete}");
    for (const command of Object.keys(routes)) {
      expect(longHelp.stdout).toContain(command);
    }
    expect(longHelp.stdout).toContain("-v");
    expect(longHelp.stdout).toContain("--version");
    expect(shortHelp).toEqual(longHelp);
  });
});

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

test.each(routeCommands)("%s help exits cleanly instead of running the command", async (command) => {
  await withIsolatedZinnDir(async (dir) => {
    // ? ZINN-67: arguments before and after the flag do not change which help prints.
    const argumentsAroundFlag = [
      { before: [], after: [] },
      { before: ["APP-1"], after: ["APP-2", "--json"] },
    ];

    for (const flag of HELP_FLAGS) {
      for (const { before, after } of argumentsAroundFlag) {
        const result = await runZinn([...command.split(" "), ...before, flag, ...after], dir);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(`Usage: zinn ${command}`);
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
