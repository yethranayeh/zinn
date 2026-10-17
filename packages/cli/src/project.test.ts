import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, runCliInTerminal } from "../testing";
import { errorDocumentSchema } from "./errors";

const PREFIX = join(tmpdir(), "zinndefaulttest-");
// Each precedence matrix starts several dozen CLI processes.
const COMMAND_MATRIX_TIMEOUT_MS = 30_000;

function withTestDirectory(run: (directory: string) => void) {
  const directory = mkdtempSync(PREFIX);

  try {
    run(directory);
  } finally {
    removeTestDirectory(directory);
  }
}

// Same as withTestDirectory, but removes the directory only after an async run settles.
async function withTestDirectoryAsync(run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(PREFIX);

  try {
    await run(directory);
  } finally {
    removeTestDirectory(directory);
  }
}

function removeTestDirectory(directory: string) {
  if (!directory.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${directory}": not a ${PREFIX}* directory`);
  }

  rmSync(directory, { recursive: true, force: true });
}

function runZinn(args: Array<string>, zinnDirectory: string) {
  return runCli(args, { env: { ...process.env, ZINN_DIR: zinnDirectory } });
}

function runZinnFrom(
  args: Array<string>,
  directory: string,
  cwd: string,
  additionalEnv: Record<string, string> = {},
) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: join(directory, "home") };
  delete env.ZINN_DIR;
  Object.assign(env, additionalEnv);

  return runCli(args, { cwd, env });
}

function runZinnWithPipedYes(args: Array<string>, directory: string, cwd: string) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: join(directory, "home") };
  delete env.ZINN_DIR;
  const cliPath = join(import.meta.dir, "..", "index.ts");
  const proc = Bun.spawnSync(
    ["/bin/sh", "-c", 'printf "y\\n" | exec bun "$@"', "zinn-confirm", cliPath, ...args],
    { cwd, env },
  );

  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), code: proc.exitCode };
}

/** Runs the CLI attached to a pseudo-terminal and types the input; stdout and stderr arrive together. */
function runZinnInTerminal(args: Array<string>, directory: string, cwd: string, input: string) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: join(directory, "home") };
  delete env.ZINN_DIR;

  return runCliInTerminal(args, { cwd, env, input });
}

function makeRepository(directory: string, localSettings: Record<string, unknown> = {}) {
  const repository = join(directory, "repository");
  const globalDirectory = join(directory, "home", ".zinn");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(globalDirectory, { recursive: true });
  writeFileSync(join(globalDirectory, "settings.json"), JSON.stringify({ storage: { directory: join(directory, "store") } }));
  writeFileSync(join(repository, "zinn.local.json"), JSON.stringify(localSettings));

  return { repository, globalSettingsPath: join(globalDirectory, "settings.json"), localSettingsPath: join(repository, "zinn.local.json") };
}

function writeGlobalSettings(directory: string, settings: Record<string, unknown>) {
  const globalSettingsPath = join(directory, "home", ".zinn", "settings.json");
  writeFileSync(globalSettingsPath, JSON.stringify({ storage: { directory: join(directory, "store") }, ...settings }));
}

function seedProjects(directory: string, store = join(directory, "store")) {
  expect(runZinn(["project", "create", "DEF", "--name", "Default"], store).code).toBe(0);
  expect(runZinn(["project", "create", "ALT", "--name", "Alternate"], store).code).toBe(0);
  expect(runZinn(["task", "create", "DEF", "--title", "needle default"], store).code).toBe(0);
  expect(runZinn(["task", "create", "ALT", "--title", "needle alternate"], store).code).toBe(0);
  expect(runZinn(["project", "column", "create", "DEF", "Only DEF"], store).code).toBe(0);
  expect(runZinn(["project", "column", "create", "ALT", "Only ALT"], store).code).toBe(0);
}

test("ZINN_DIR selects an empty or populated store without applying the repository default", () => {
  withTestDirectory((directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    const emptyStore = join(directory, "empty-store");
    const emptyRun = (...args: Array<string>) => runZinnFrom(args, directory, repository, { ZINN_DIR: emptyStore });

    for (const args of [["task", "list"], ["task", "search", "needle"]]) {
      const result = emptyRun(...args, "--json");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    }

    const populatedStore = join(directory, "populated-store");
    seedProjects(directory, populatedStore);
    const populatedRun = (...args: Array<string>) => runZinnFrom(args, directory, repository, { ZINN_DIR: populatedStore });
    expect(JSON.parse(populatedRun("task", "list", "--json").stdout).map((task: { key: string }) => task.key).sort()).toEqual([
      "ALT-1",
      "DEF-1",
    ]);
    expect(JSON.parse(populatedRun("task", "search", "needle", "--json").stdout).map((task: { key: string }) => task.key).sort()).toEqual([
      "ALT-1",
      "DEF-1",
    ]);
  });
});

test("ZINN_DIR uses its own default and reports unknown defaults from its settings file", () => {
  withTestDirectory((directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    const store = join(directory, "store");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "settings.json"), JSON.stringify({ defaultProject: "ALT" }));
    seedProjects(directory, store);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository, { ZINN_DIR: store });

    expect(JSON.parse(invoke("task", "list", "--json").stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);
    expect(JSON.parse(invoke("task", "search", "needle", "--json").stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);

    writeFileSync(join(store, "settings.json"), JSON.stringify({ defaultProject: "NOPE" }));
    const unknown = invoke("task", "list", "--json");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("NOPE");
    expect(unknown.stderr).toContain(join(store, "settings.json"));

    expect(JSON.parse(invoke("task", "list", "ALT", "--json").stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);
    expect(JSON.parse(invoke("task", "list", "--all-projects", "--json").stdout)).toHaveLength(2);
    expect(JSON.parse(invoke("task", "search", " alt-1 ", "--json").stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);
  });
});

test("ZINN_DIR ignores malformed repository and home settings but validates its own settings", () => {
  withTestDirectory((directory) => {
    const { repository, localSettingsPath, globalSettingsPath } = makeRepository(directory);
    const store = join(directory, "store");
    writeFileSync(localSettingsPath, "{");
    writeFileSync(globalSettingsPath, "{");
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository, { ZINN_DIR: store });

    const ignoredMalformedFiles = invoke("task", "list", "--json");
    expect(ignoredMalformedFiles.code).toBe(0);
    expect(JSON.parse(ignoredMalformedFiles.stdout)).toEqual([]);
    expect(ignoredMalformedFiles.stderr).not.toContain(localSettingsPath);
    expect(ignoredMalformedFiles.stderr).not.toContain(globalSettingsPath);

    const selectedStoreSettingsPath = join(store, "settings.json");
    writeFileSync(selectedStoreSettingsPath, JSON.stringify({ defaultProject: 42 }));
    const invalidSelectedStoreSettings = invoke("task", "list", "--json");
    expect(invalidSelectedStoreSettings.code).toBe(1);
    expect(invalidSelectedStoreSettings.stderr).toContain(selectedStoreSettingsPath);
    expect(invalidSelectedStoreSettings.stderr).toContain("defaultProject");
  });
});

async function expectDefaultCommands(directory: string, repository: string, expectedKey: string, otherKey: string) {
  const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);
  const list = invoke("task", "list", "--json");
  const search = invoke("task", "search", "needle", "--json");
  const created = invoke("task", "create", "--title", "created by default", "--json");
  const viewed = invoke("project", "view", "--json");
  const columns = invoke("project", "column", "list", "--json");
  const edited = invoke("project", "edit", "--name", "Edited by default", "--json");

  expect(list.code).toBe(0);
  expect(JSON.parse(list.stdout).map((task: { key: string }) => task.key)).toEqual([`${expectedKey}-1`]);
  expect(search.code).toBe(0);
  expect(JSON.parse(search.stdout).map((task: { key: string }) => task.key)).toEqual([`${expectedKey}-1`]);
  expect(created.code).toBe(0);
  expect(JSON.parse(created.stdout).key).toBe(`${expectedKey}-2`);
  expect(viewed.code).toBe(0);
  expect(JSON.parse(viewed.stdout).key).toBe(expectedKey);
  expect(columns.code).toBe(0);
  expect(JSON.parse(columns.stdout).map((column: { name: string }) => column.name)).toContain(`Only ${expectedKey}`);
  expect(edited.code).toBe(0);
  expect(JSON.parse(edited.stdout)).toMatchObject({ key: expectedKey, name: "Edited by default" });

  const explicitList = invoke("task", "list", otherKey, "--json");
  const explicitSearch = invoke("task", "search", "needle", otherKey, "--json");
  const explicitCreate = invoke("task", "create", otherKey, "--title", "created explicitly", "--json");
  const explicitView = invoke("project", "view", otherKey, "--json");
  const explicitColumns = invoke("project", "column", "list", otherKey, "--json");
  const explicitEdit = invoke("project", "edit", otherKey, "--name", "Edited explicitly", "--json");

  expect(JSON.parse(explicitList.stdout).map((task: { key: string }) => task.key)).toEqual([`${otherKey}-1`]);
  expect(JSON.parse(explicitSearch.stdout).map((task: { key: string }) => task.key)).toEqual([`${otherKey}-1`]);
  expect(JSON.parse(explicitCreate.stdout).key).toBe(`${otherKey}-2`);
  expect(JSON.parse(explicitView.stdout).key).toBe(otherKey);
  expect(JSON.parse(explicitColumns.stdout).map((column: { name: string }) => column.name)).toContain(`Only ${otherKey}`);
  expect(JSON.parse(explicitEdit.stdout)).toMatchObject({ key: otherKey, name: "Edited explicitly" });
  expect(JSON.parse(invoke("task", "view", `${otherKey}-1`, "--json").stdout).key).toBe(`${otherKey}-1`);

  const deleted = await runZinnInTerminal(["project", "delete"], directory, repository, "y\n");
  expect(deleted.code).toBe(0);
  expect(deleted.output).toContain(expectedKey);
  expect(JSON.parse(invoke("project", "list", "--json").stdout).map((project: { key: string }) => project.key)).toEqual([otherKey]);
  const explicitDelete = runZinnFrom(["project", "delete", otherKey, "--yes", "--json"], directory, repository);
  expect(explicitDelete.code).toBe(0);
  expect(JSON.parse(explicitDelete.stdout).key).toBe(otherKey);
}

test("each default-project command uses local settings, overrides global settings and yields to a typed key", async () => {
  await withTestDirectoryAsync(async (directory) => {
    makeRepository(directory, { defaultProject: "def" });
    writeGlobalSettings(directory, { defaultProject: "ALT" });
    seedProjects(directory);

    await expectDefaultCommands(directory, join(directory, "repository"), "DEF", "ALT");
  });
}, COMMAND_MATRIX_TIMEOUT_MS);

test("each default-project command falls back to global settings when local settings omit the field", async () => {
  await withTestDirectoryAsync(async (directory) => {
    makeRepository(directory, {});
    writeGlobalSettings(directory, { defaultProject: "DEF" });
    seedProjects(directory);

    await expectDefaultCommands(directory, join(directory, "repository"), "DEF", "ALT");
  });
}, COMMAND_MATRIX_TIMEOUT_MS);

test("commands without a default keep their existing project behavior, and task-key commands stay project-specific", () => {
  withTestDirectory((directory) => {
    const { repository } = makeRepository(directory);
    seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    expect(JSON.parse(invoke("task", "list", "--json").stdout)).toHaveLength(2);
    expect(JSON.parse(invoke("task", "search", "needle", "--json").stdout)).toHaveLength(2);
    expect(JSON.parse(invoke("task", "list", "--all-projects", "--json").stdout)).toHaveLength(2);
    expect(JSON.parse(invoke("task", "search", "needle", "--all-projects", "--json").stdout)).toHaveLength(2);
    expect(invoke("task", "create", "--title", "needs a project").code).toBe(1);
    expect(invoke("project", "view").code).toBe(1);
    expect(invoke("project", "column", "list").code).toBe(1);
    expect(invoke("project", "edit", "--name", "No project").code).toBe(1);
    expect(invoke("project", "delete").code).toBe(1);
    expect(JSON.parse(invoke("task", "view", "ALT-1", "--json").stdout).key).toBe("ALT-1");
  });
});

test("all-projects bypasses an unknown default, conflicts with typed keys, and keeps list filters", () => {
  withTestDirectory((directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "NOPE" });
    seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    for (const args of [["task", "list"], ["task", "search", "needle"]]) {
      const allProjects = invoke(...args, "--all-projects", "--json");
      expect(allProjects.code).toBe(0);
      expect(JSON.parse(allProjects.stdout)).toHaveLength(2);
      const typedConflict = args[1] === "list"
        ? invoke("task", "list", "ALT", "--all-projects", "--json")
        : invoke("task", "search", "needle", "ALT", "--all-projects", "--json");
      expect(typedConflict.code).toBe(1);
    }

    const defaultUnknown = invoke("task", "list", "--json");
    expect(defaultUnknown.code).toBe(1);
    expect(defaultUnknown.stderr).toContain("NOPE");
    expect(defaultUnknown.stderr).toContain(join(repository, "zinn.local.json"));

    writeFileSync(join(repository, "zinn.local.json"), JSON.stringify({ defaultProject: "DEF" }));
    expect(runZinn(["task", "archive", "DEF-1"], join(directory, "store")).code).toBe(0);
    const active = invoke("task", "list", "--all-projects", "--json");
    const all = invoke("task", "list", "--all-projects", "--all", "--json");
    const archived = invoke("task", "list", "--all-projects", "--archived", "--json");
    const searchAll = invoke("task", "search", "needle", "--all-projects", "--all", "--json");
    const searchArchived = invoke("task", "search", "needle", "--all-projects", "--archived", "--json");
    expect(JSON.parse(active.stdout)).toHaveLength(1);
    expect(JSON.parse(all.stdout)).toHaveLength(2);
    expect(JSON.parse(archived.stdout).map((task: { key: string }) => task.key)).toEqual(["DEF-1"]);
    expect(JSON.parse(searchAll.stdout)).toHaveLength(2);
    expect(JSON.parse(searchArchived.stdout).map((task: { key: string }) => task.key)).toEqual(["DEF-1"]);
  });
});

test("task-key search queries use the matching project instead of a default and keep an explicit project filter", () => {
  withTestDirectory((directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    expect(JSON.parse(invoke("task", "search", "needle", "--json").stdout).map((task: { key: string }) => task.key)).toEqual(["DEF-1"]);
    expect(JSON.parse(invoke("task", "search", "ALT-1", "--json").stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);

    writeFileSync(join(repository, "zinn.local.json"), JSON.stringify({ defaultProject: "NOPE" }));
    expect(JSON.parse(invoke("task", "search", " alt-1 ", "--json").stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);

    const filtered = invoke("task", "search", " ALT-1 ", "DEF", "--json");
    expect(filtered.code).toBe(0);
    expect(JSON.parse(filtered.stdout)).toEqual([]);

    const conflict = invoke("task", "search", "ALT-1", "DEF", "--all-projects", "--json");
    expect(conflict.code).toBe(1);
    expect(conflict.stdout).toBe("");
    expect(conflict.stderr).toContain("--all-projects");
  });
});

test("task list and search report conflicting archive flags before resolving an unknown default", () => {
  withTestDirectory((directory) => {
    const { repository, localSettingsPath } = makeRepository(directory, { defaultProject: "NOPE" });
    seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    for (const args of [["task", "list"], ["task", "search", "needle"]]) {
      const result = invoke(...args, "--archived", "--all", "--json");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--archived");
      expect(result.stderr).toContain("--all");
      expect(result.stderr).not.toContain("NOPE");
      expect(result.stderr).not.toContain(localSettingsPath);
    }
  });
});

test("a missing conditional project key reports its value and optional usage", () => {
  withTestDirectory((directory) => {
    const { repository } = makeRepository(directory);
    seedProjects(directory);
    const result = runZinnFrom(["project", "view", "--json"], directory, repository);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error.message).toContain("<project-key>");
    expect(error.message).toContain("defaultProject");
    expect(error.help).toContain("Usage: zinn project view [<project-key>]");
  });
});

test("unknown defaults identify their key and settings file", () => {
  withTestDirectory((directory) => {
    const { repository, globalSettingsPath, localSettingsPath } = makeRepository(directory, { defaultProject: "NOPE" });
    seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);
    const assertUnknownDefaultDoesNotMutate = (settingsPath: string) => {
      for (const args of [
        ["project", "view", "--json"],
        ["task", "create", "--title", "must not be created", "--json"],
        ["project", "edit", "--name", "Must not be applied", "--json"],
        ["project", "delete", "--yes"],
      ]) {
        const result = invoke(...args);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("NOPE");
        expect(result.stderr).toContain(settingsPath);
      }

      expect(JSON.parse(invoke("project", "view", "DEF", "--json").stdout).name).toBe("Default");
      expect(JSON.parse(invoke("task", "list", "DEF", "--json").stdout)).toHaveLength(1);
    };

    assertUnknownDefaultDoesNotMutate(localSettingsPath);

    const explicitList = invoke("task", "list", "ALT", "--json");
    const explicitSearch = invoke("task", "search", "needle", "ALT", "--json");
    const explicitCreate = invoke("task", "create", "ALT", "--title", "typed key bypasses unknown default", "--json");
    const explicitView = invoke("project", "view", "ALT", "--json");
    const explicitColumns = invoke("project", "column", "list", "ALT", "--json");
    const explicitEdit = invoke("project", "edit", "ALT", "--name", "Edited explicitly", "--json");
    const explicitDelete = invoke("project", "delete", "ALT", "--yes", "--json");
    expect(explicitList.code).toBe(0);
    expect(explicitSearch.code).toBe(0);
    expect(JSON.parse(explicitCreate.stdout).key).toBe("ALT-2");
    expect(JSON.parse(explicitView.stdout).key).toBe("ALT");
    expect(explicitColumns.code).toBe(0);
    expect(JSON.parse(explicitEdit.stdout).name).toBe("Edited explicitly");
    expect(JSON.parse(explicitDelete.stdout).key).toBe("ALT");
    expect(JSON.parse(invoke("project", "view", "DEF", "--json").stdout).name).toBe("Default");

    writeFileSync(join(repository, "zinn.local.json"), "{}");
    writeGlobalSettings(directory, { defaultProject: "NOPE" });
    assertUnknownDefaultDoesNotMutate(globalSettingsPath);
  });
});

test("project delete with a default prompts despite --yes, and refuses without a terminal or with JSON", async () => {
  const directory = mkdtempSync(PREFIX);

  try {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    seedProjects(directory);
    const jsonRefusal = runZinnFrom(["project", "delete", "--yes", "--json"], directory, repository);
    expect(jsonRefusal.code).toBe(1);
    expect(jsonRefusal.stdout).toBe("");
    const refusal = JSON.parse(jsonRefusal.stderr);
    expect(Object.keys(refusal)).toEqual(["error"]);
    expect(errorDocumentSchema.safeParse(refusal).success).toBe(true);
    expect(refusal.error.code).toBe("invalid_input");
    expect(refusal.error.details.reason).toBe("confirmation_required");
    expect(typeof refusal.error.message).toBe("string");
    expect(JSON.parse(runZinnFrom(["project", "list", "--json"], directory, repository).stdout)).toHaveLength(2);

    const noInput = runZinnFrom(["project", "delete", "--yes"], directory, repository);
    const pipedInput = runZinnWithPipedYes(["project", "delete", "--yes"], directory, repository);
    for (const result of [noInput, pipedInput]) {
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("zinn project delete DEF --yes");
    }
    expect(JSON.parse(runZinnFrom(["project", "list", "--json"], directory, repository).stdout)).toHaveLength(2);

    const prompted = await runZinnInTerminal(["project", "delete", "--yes"], directory, repository, "y\n");
    expect(prompted.code).toBe(0);
    expect(prompted.output).toContain("--yes");
    expect(prompted.output).toContain("Default");
    expect(JSON.parse(runZinnFrom(["project", "list", "--json"], directory, repository).stdout).map((project: { key: string }) => project.key)).toEqual(["ALT"]);
  } finally {
    removeTestDirectory(directory);
  }
});

test("malformed defaultProject settings still fail with a typed key or --all-projects", () => {
  withTestDirectory((directory) => {
    const { repository, localSettingsPath } = makeRepository(directory, { defaultProject: 42 });
    seedProjects(directory);
    const typed = runZinnFrom(["task", "list", "ALT", "--json"], directory, repository);
    const allProjects = runZinnFrom(["task", "list", "--all-projects", "--json"], directory, repository);

    for (const result of [typed, allProjects]) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(localSettingsPath);
      expect(result.stderr).toContain("defaultProject");
    }
  });
});

test("project delete with a typed key and --yes deletes without prompting", () => {
  withTestDirectory((directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    seedProjects(directory);

    const result = runZinnFrom(["project", "delete", "ALT", "--yes", "--json"], directory, repository);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).key).toBe("ALT");
    expect(JSON.parse(runZinnFrom(["project", "list", "--json"], directory, repository).stdout).map((project: { key: string }) => project.key)).toEqual(["DEF"]);
  });
});

test("column writes still require an explicit project key when a default is set", () => {
  withTestDirectory((directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    expect(invoke("project", "column", "create", "Later", "--json").code).toBe(1);
    expect(invoke("project", "column", "edit", "Backlog", "--name", "Later", "--json").code).toBe(1);
    expect(invoke("project", "column", "order", "Backlog", "first", "--json").code).toBe(1);
    const listedColumns = invoke("project", "column", "list", "--json");
    expect(listedColumns.code).toBe(0);
    expect(JSON.parse(listedColumns.stdout).map((column: { name: string }) => column.name)).toContain("Only DEF");
  });
});
