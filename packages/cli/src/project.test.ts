import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, runCliInTerminal, runProcessAsync } from "../testing";
import { createEmptyDatabase } from "../test-helpers";
import { errorDocumentSchema } from "./errors";

const PREFIX = join(tmpdir(), "zinndefaulttest-");
// Each precedence matrix starts several dozen CLI processes.
const COMMAND_MATRIX_TIMEOUT_MS = 30_000;

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
  return runCli(args, { env: { ...TEST_ENVIRONMENT, ZINN_DIR: zinnDirectory } });
}

function runZinnFrom(
  args: Array<string>,
  directory: string,
  cwd: string,
  additionalEnv: Record<string, string> = {},
) {
  const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: join(directory, "home") };
  delete env.ZINN_DIR;
  Object.assign(env, additionalEnv);

  return runCli(args, { cwd, env });
}

function runZinnWithPipedYes(args: Array<string>, directory: string, cwd: string) {
  const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: join(directory, "home") };
  delete env.ZINN_DIR;
  const cliPath = join(import.meta.dir, "..", "index.ts");

  return runProcessAsync(
    ["/bin/sh", "-c", 'printf "y\\n" | exec bun "$@"', "zinn-confirm", cliPath, ...args],
    { cwd, env },
  );
}

/** Runs the CLI attached to a pseudo-terminal and types the input; stdout and stderr arrive together. */
function runZinnInTerminal(args: Array<string>, directory: string, cwd: string, input: string) {
  const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: join(directory, "home") };
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

async function seedProjects(directory: string, store = join(directory, "store")) {
  mkdirSync(store, { recursive: true });
  expect((await runZinn(["project", "create", "DEF", "--name", "Default"], store)).code).toBe(0);
  expect((await runZinn(["project", "create", "ALT", "--name", "Alternate"], store)).code).toBe(0);
  expect((await runZinn(["task", "create", "DEF", "--title", "needle default"], store)).code).toBe(0);
  expect((await runZinn(["task", "create", "ALT", "--title", "needle alternate"], store)).code).toBe(0);
  expect((await runZinn(["project", "column", "create", "--category", "todo", "DEF", "Only DEF"], store)).code).toBe(0);
  expect((await runZinn(["project", "column", "create", "--category", "todo", "ALT", "Only ALT"], store)).code).toBe(0);
}

test("ZINN_DIR selects an empty or populated store without applying the repository default", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    const emptyStore = join(directory, "empty-store");
    mkdirSync(emptyStore);
    const emptyRun = (...args: Array<string>) => runZinnFrom(args, directory, repository, { ZINN_DIR: emptyStore });
    createEmptyDatabase(emptyStore);

    for (const args of [["task", "list"], ["task", "search", "needle"]]) {
      const result = await emptyRun(...args, "--json");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    }

    const populatedStore = join(directory, "populated-store");
    await seedProjects(directory, populatedStore);
    const populatedRun = (...args: Array<string>) => runZinnFrom(args, directory, repository, { ZINN_DIR: populatedStore });
    expect(JSON.parse((await populatedRun("task", "list", "--json")).stdout).map((task: { key: string }) => task.key).sort()).toEqual([
      "ALT-1",
      "DEF-1",
    ]);
    expect(JSON.parse((await populatedRun("task", "search", "needle", "--json")).stdout).map((task: { key: string }) => task.key).sort()).toEqual([
      "ALT-1",
      "DEF-1",
    ]);
  });
});

test("ZINN_DIR uses its own default and reports unknown defaults from its settings file", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    const store = join(directory, "store");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "settings.json"), JSON.stringify({ defaultProject: "ALT" }));
    await seedProjects(directory, store);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository, { ZINN_DIR: store });

    expect(JSON.parse((await invoke("task", "list", "--json")).stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);
    expect(JSON.parse((await invoke("task", "search", "needle", "--json")).stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);

    writeFileSync(join(store, "settings.json"), JSON.stringify({ defaultProject: "NOPE" }));
    const unknown = await invoke("task", "list", "--json");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("NOPE");
    expect(unknown.stderr).toContain(join(store, "settings.json"));

    expect(JSON.parse((await invoke("task", "list", "ALT", "--json")).stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);
    expect(JSON.parse((await invoke("task", "list", "--all-projects", "--json")).stdout)).toHaveLength(2);
    expect(JSON.parse((await invoke("task", "search", " alt-1 ", "--json")).stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);
  });
});

test.serial("ZINN_DIR ignores malformed repository and home settings but validates its own settings", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository, localSettingsPath, globalSettingsPath } = makeRepository(directory);
    const store = join(directory, "store");
    writeFileSync(localSettingsPath, "{");
    writeFileSync(globalSettingsPath, "{");
    mkdirSync(store);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository, { ZINN_DIR: store });
    createEmptyDatabase(store);

    const ignoredMalformedFiles = await invoke("task", "list", "--json");
    expect(ignoredMalformedFiles.code).toBe(0);
    expect(JSON.parse(ignoredMalformedFiles.stdout)).toEqual([]);
    expect(ignoredMalformedFiles.stderr).not.toContain(localSettingsPath);
    expect(ignoredMalformedFiles.stderr).not.toContain(globalSettingsPath);

    const selectedStoreSettingsPath = join(store, "settings.json");
    writeFileSync(selectedStoreSettingsPath, JSON.stringify({ defaultProject: 42 }));
    const invalidSelectedStoreSettings = await invoke("task", "list", "--json");
    expect(invalidSelectedStoreSettings.code).toBe(1);
    expect(invalidSelectedStoreSettings.stderr).toContain(selectedStoreSettingsPath);
    expect(invalidSelectedStoreSettings.stderr).toContain("defaultProject");
  });
});

async function expectDefaultCommands(directory: string, repository: string, expectedKey: string, otherKey: string) {
  const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);
  const list = await invoke("task", "list", "--json");
  const search = await invoke("task", "search", "needle", "--json");
  const created = await invoke("task", "create", "--title", "created by default", "--json");
  const viewed = await invoke("project", "view", "--json");
  const columns = await invoke("project", "column", "list", "--json");
  const edited = await invoke("project", "edit", "--name", "Edited by default", "--json");

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

  const explicitList = await invoke("task", "list", otherKey, "--json");
  const explicitSearch = await invoke("task", "search", "needle", otherKey, "--json");
  const explicitCreate = await invoke("task", "create", otherKey, "--title", "created explicitly", "--json");
  const explicitView = await invoke("project", "view", otherKey, "--json");
  const explicitColumns = await invoke("project", "column", "list", otherKey, "--json");
  const explicitEdit = await invoke("project", "edit", otherKey, "--name", "Edited explicitly", "--json");

  expect(JSON.parse(explicitList.stdout).map((task: { key: string }) => task.key)).toEqual([`${otherKey}-1`]);
  expect(JSON.parse(explicitSearch.stdout).map((task: { key: string }) => task.key)).toEqual([`${otherKey}-1`]);
  expect(JSON.parse(explicitCreate.stdout).key).toBe(`${otherKey}-2`);
  expect(JSON.parse(explicitView.stdout).key).toBe(otherKey);
  expect(JSON.parse(explicitColumns.stdout).map((column: { name: string }) => column.name)).toContain(`Only ${otherKey}`);
  expect(JSON.parse(explicitEdit.stdout)).toMatchObject({ key: otherKey, name: "Edited explicitly" });
  expect(JSON.parse((await invoke("task", "view", `${otherKey}-1`, "--json")).stdout).key).toBe(`${otherKey}-1`);

  const deleted = await runZinnInTerminal(["project", "delete"], directory, repository, "y\n");
  expect(deleted.code).toBe(0);
  expect(deleted.output).toContain(expectedKey);
  expect(JSON.parse((await invoke("project", "list", "--json")).stdout).map((project: { key: string }) => project.key)).toEqual([otherKey]);
  const explicitDelete = await runZinnFrom(["project", "delete", otherKey, "--yes", "--json"], directory, repository);
  expect(explicitDelete.code).toBe(0);
  expect(JSON.parse(explicitDelete.stdout).key).toBe(otherKey);
}

test("each default-project command uses local settings, overrides global settings and yields to a typed key", async () => {
  await withTestDirectoryAsync(async (directory) => {
    makeRepository(directory, { defaultProject: "def" });
    writeGlobalSettings(directory, { defaultProject: "ALT" });
    await seedProjects(directory);

    await expectDefaultCommands(directory, join(directory, "repository"), "DEF", "ALT");
  });
}, COMMAND_MATRIX_TIMEOUT_MS);

test("each default-project command falls back to global settings when local settings omit the field", async () => {
  await withTestDirectoryAsync(async (directory) => {
    makeRepository(directory, {});
    writeGlobalSettings(directory, { defaultProject: "DEF" });
    await seedProjects(directory);

    await expectDefaultCommands(directory, join(directory, "repository"), "DEF", "ALT");
  });
}, COMMAND_MATRIX_TIMEOUT_MS);

test("commands without a default keep their existing project behavior, and task-key commands stay project-specific", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository } = makeRepository(directory);
    await seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    expect(JSON.parse((await invoke("task", "list", "--json")).stdout)).toHaveLength(2);
    expect(JSON.parse((await invoke("task", "search", "needle", "--json")).stdout)).toHaveLength(2);
    expect(JSON.parse((await invoke("task", "list", "--all-projects", "--json")).stdout)).toHaveLength(2);
    expect(JSON.parse((await invoke("task", "search", "needle", "--all-projects", "--json")).stdout)).toHaveLength(2);
    expect((await invoke("task", "create", "--title", "needs a project")).code).toBe(1);
    expect((await invoke("project", "view")).code).toBe(1);
    expect((await invoke("project", "column", "list")).code).toBe(1);
    expect((await invoke("project", "edit", "--name", "No project")).code).toBe(1);
    expect((await invoke("project", "delete")).code).toBe(1);
    expect(JSON.parse((await invoke("task", "view", "ALT-1", "--json")).stdout).key).toBe("ALT-1");
  });
});

test("all-projects bypasses an unknown default, conflicts with typed keys, and keeps list filters", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "NOPE" });
    await seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    for (const args of [["task", "list"], ["task", "search", "needle"]]) {
      const allProjects = await invoke(...args, "--all-projects", "--json");
      expect(allProjects.code).toBe(0);
      expect(JSON.parse(allProjects.stdout)).toHaveLength(2);
      const typedConflict = args[1] === "list"
        ? (await invoke("task", "list", "ALT", "--all-projects", "--json"))
        : (await invoke("task", "search", "needle", "ALT", "--all-projects", "--json"));
      expect(typedConflict.code).toBe(1);
    }

    const defaultUnknown = await invoke("task", "list", "--json");
    expect(defaultUnknown.code).toBe(1);
    expect(defaultUnknown.stderr).toContain("NOPE");
    expect(defaultUnknown.stderr).toContain(join(repository, "zinn.local.json"));

    writeFileSync(join(repository, "zinn.local.json"), JSON.stringify({ defaultProject: "DEF" }));
    expect((await runZinn(["task", "archive", "DEF-1"], join(directory, "store"))).code).toBe(0);
    const active = await invoke("task", "list", "--all-projects", "--json");
    const all = await invoke("task", "list", "--all-projects", "--all", "--json");
    const archived = await invoke("task", "list", "--all-projects", "--archived", "--json");
    const searchAll = await invoke("task", "search", "needle", "--all-projects", "--all", "--json");
    const searchArchived = await invoke("task", "search", "needle", "--all-projects", "--archived", "--json");
    expect(JSON.parse(active.stdout)).toHaveLength(1);
    expect(JSON.parse(all.stdout)).toHaveLength(2);
    expect(JSON.parse(archived.stdout).map((task: { key: string }) => task.key)).toEqual(["DEF-1"]);
    expect(JSON.parse(searchAll.stdout)).toHaveLength(2);
    expect(JSON.parse(searchArchived.stdout).map((task: { key: string }) => task.key)).toEqual(["DEF-1"]);
  });
});

test("task-key search queries use the matching project instead of a default and keep an explicit project filter", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    await seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    expect(JSON.parse((await invoke("task", "search", "needle", "--json")).stdout).map((task: { key: string }) => task.key)).toEqual(["DEF-1"]);
    expect(JSON.parse((await invoke("task", "search", "ALT-1", "--json")).stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);

    writeFileSync(join(repository, "zinn.local.json"), JSON.stringify({ defaultProject: "NOPE" }));
    expect(JSON.parse((await invoke("task", "search", " alt-1 ", "--json")).stdout).map((task: { key: string }) => task.key)).toEqual(["ALT-1"]);

    const filtered = await invoke("task", "search", " ALT-1 ", "DEF", "--json");
    expect(filtered.code).toBe(0);
    expect(JSON.parse(filtered.stdout)).toEqual([]);

    const conflict = await invoke("task", "search", "ALT-1", "DEF", "--all-projects", "--json");
    expect(conflict.code).toBe(1);
    expect(conflict.stdout).toBe("");
    expect(conflict.stderr).toContain("--all-projects");
  });
});

test("task search reports missing projects with query-first usage and preserves error details", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository, localSettingsPath } = makeRepository(directory);
    await seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    for (const settings of [{}, { defaultProject: "DEF" }]) {
      writeFileSync(localSettingsPath, JSON.stringify(settings));

      const plain = await invoke("task", "search", "DEF", "needle");
      expect(plain.code).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain("needle");
      expect(plain.stderr).toContain("zinn task search <query>");
      expect(plain.stderr).toContain("<project-key>");
      expect(plain.stderr.indexOf("needle")).toBeLessThan(plain.stderr.indexOf("<query>"));

      const json = await invoke("task", "search", "DEF", "needle", "--json");
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      const failure = errorDocumentSchema.parse(JSON.parse(json.stderr)).error;
      expect(failure).toMatchObject({
        code: "not_found",
        details: { entity: "project", key: "needle", source: "explicit" },
      });
      expect(failure.help).toContain("zinn task search <query>");
      expect(failure.help).toContain("<project-key>");
      expect(plain.stderr).toBe(`${failure.message}\n\n${failure.help}\n`);

      const correct = await invoke("task", "search", "needle", "DEF", "--json");
      expect(correct.code).toBe(0);
      expect(correct.stderr).toBe("");
      expect(JSON.parse(correct.stdout).map((task: { key: string }) => task.key)).toEqual(["DEF-1"]);
    }

    writeFileSync(localSettingsPath, JSON.stringify({ defaultProject: "NOPE" }));
    const unknownDefault = await invoke("task", "search", "needle", "--json");
    expect(unknownDefault.code).toBe(1);
    expect(unknownDefault.stdout).toBe("");
    const failure = errorDocumentSchema.parse(JSON.parse(unknownDefault.stderr)).error;
    expect(failure).toMatchObject({
      code: "not_found",
      details: { entity: "project", key: "NOPE", source: "defaultProject", settingsPath: realpathSync(localSettingsPath) },
    });
    expect(failure.help).toContain("zinn task search <query>");
    expect(failure.help).toContain("<project-key>");

    const otherCommand = await invoke("task", "list", "needle", "--json");
    expect(otherCommand.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(otherCommand.stderr)).error.help).toBeUndefined();
  });
});

test("task list and search report conflicting archive flags before resolving an unknown default", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository, localSettingsPath } = makeRepository(directory, { defaultProject: "NOPE" });
    await seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    for (const args of [["task", "list"], ["task", "search", "needle"]]) {
      const result = await invoke(...args, "--archived", "--all", "--json");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--archived");
      expect(result.stderr).toContain("--all");
      expect(result.stderr).not.toContain("NOPE");
      expect(result.stderr).not.toContain(localSettingsPath);
    }
  });
});

test("a missing conditional project key reports its value and optional usage", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository } = makeRepository(directory);
    await seedProjects(directory);
    const result = await runZinnFrom(["project", "view", "--json"], directory, repository);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error.message).toContain("<project-key>");
    expect(error.message).toContain("defaultProject");
    expect(error.help).toContain("Usage: zinn project view [<project-key>]");
  });
});

test("unknown defaults identify their key and settings file", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository, globalSettingsPath, localSettingsPath } = makeRepository(directory, { defaultProject: "NOPE" });
    await seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);
    const assertUnknownDefaultDoesNotMutate = async (settingsPath: string) => {
      for (const args of [
        ["project", "view", "--json"],
        ["task", "create", "--title", "must not be created", "--json"],
        ["project", "edit", "--name", "Must not be applied", "--json"],
        ["project", "delete", "--yes"],
      ]) {
        const result = await invoke(...args);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("NOPE");
        expect(result.stderr).toContain(settingsPath);
      }

      expect(JSON.parse((await invoke("project", "view", "DEF", "--json")).stdout).name).toBe("Default");
      expect(JSON.parse((await invoke("task", "list", "DEF", "--json")).stdout)).toHaveLength(1);
    };

    await assertUnknownDefaultDoesNotMutate(localSettingsPath);

    const explicitList = await invoke("task", "list", "ALT", "--json");
    const explicitSearch = await invoke("task", "search", "needle", "ALT", "--json");
    const explicitCreate = await invoke("task", "create", "ALT", "--title", "typed key bypasses unknown default", "--json");
    const explicitView = await invoke("project", "view", "ALT", "--json");
    const explicitColumns = await invoke("project", "column", "list", "ALT", "--json");
    const explicitEdit = await invoke("project", "edit", "ALT", "--name", "Edited explicitly", "--json");
    const explicitDelete = await invoke("project", "delete", "ALT", "--yes", "--json");
    expect(explicitList.code).toBe(0);
    expect(explicitSearch.code).toBe(0);
    expect(JSON.parse(explicitCreate.stdout).key).toBe("ALT-2");
    expect(JSON.parse(explicitView.stdout).key).toBe("ALT");
    expect(explicitColumns.code).toBe(0);
    expect(JSON.parse(explicitEdit.stdout).name).toBe("Edited explicitly");
    expect(JSON.parse(explicitDelete.stdout).key).toBe("ALT");
    expect(JSON.parse((await invoke("project", "view", "DEF", "--json")).stdout).name).toBe("Default");

    writeFileSync(join(repository, "zinn.local.json"), "{}");
    writeGlobalSettings(directory, { defaultProject: "NOPE" });
    await assertUnknownDefaultDoesNotMutate(globalSettingsPath);
  });
});

test.serial("project delete with a default prompts despite --yes, and refuses without a terminal or with JSON", async () => {
  const directory = mkdtempSync(PREFIX);

  try {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    await seedProjects(directory);
    const jsonRefusal = await runZinnFrom(["project", "delete", "--yes", "--json"], directory, repository);
    expect(jsonRefusal.code).toBe(1);
    expect(jsonRefusal.stdout).toBe("");
    const refusal = JSON.parse(jsonRefusal.stderr);
    expect(Object.keys(refusal)).toEqual(["error"]);
    expect(errorDocumentSchema.safeParse(refusal).success).toBe(true);
    expect(refusal.error.code).toBe("invalid_input");
    expect(refusal.error.details.reason).toBe("confirmation_required");
    expect(typeof refusal.error.message).toBe("string");
    expect(JSON.parse((await runZinnFrom(["project", "list", "--json"], directory, repository)).stdout)).toHaveLength(2);

    const noInput = await runZinnFrom(["project", "delete", "--yes"], directory, repository);
    const pipedInput = await runZinnWithPipedYes(["project", "delete", "--yes"], directory, repository);
    for (const result of [noInput, pipedInput]) {
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("zinn project delete DEF --yes");
    }
    expect(JSON.parse((await runZinnFrom(["project", "list", "--json"], directory, repository)).stdout)).toHaveLength(2);

    const prompted = await runZinnInTerminal(["project", "delete", "--yes"], directory, repository, "y\n");
    expect(prompted.code).toBe(0);
    expect(prompted.output).toContain("--yes");
    expect(prompted.output).toContain("Default");
    expect(JSON.parse((await runZinnFrom(["project", "list", "--json"], directory, repository)).stdout).map((project: { key: string }) => project.key)).toEqual(["ALT"]);
  } finally {
    removeTestDirectory(directory);
  }
});

test("malformed defaultProject settings still fail with a typed key or --all-projects", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository, localSettingsPath } = makeRepository(directory, { defaultProject: 42 });
    await seedProjects(directory);
    const typed = await runZinnFrom(["task", "list", "ALT", "--json"], directory, repository);
    const allProjects = await runZinnFrom(["task", "list", "--all-projects", "--json"], directory, repository);

    for (const result of [typed, allProjects]) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(localSettingsPath);
      expect(result.stderr).toContain("defaultProject");
    }
  });
});

test("project delete with a typed key and --yes deletes without prompting", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    await seedProjects(directory);

    const result = await runZinnFrom(["project", "delete", "ALT", "--yes", "--json"], directory, repository);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).key).toBe("ALT");
    expect(JSON.parse((await runZinnFrom(["project", "list", "--json"], directory, repository)).stdout).map((project: { key: string }) => project.key)).toEqual(["DEF"]);
  });
});

test("column writes still require an explicit project key when a default is set", async () => {
  await withTestDirectoryAsync(async (directory) => {
    const { repository } = makeRepository(directory, { defaultProject: "DEF" });
    await seedProjects(directory);
    const invoke = (...args: Array<string>) => runZinnFrom(args, directory, repository);

    expect((await invoke("project", "column", "create", "--category", "todo", "Later", "--json")).code).toBe(1);
    expect((await invoke("project", "column", "edit", "Backlog", "--name", "Later", "--json")).code).toBe(1);
    expect((await invoke("project", "column", "order", "Backlog", "first", "--json")).code).toBe(1);
    const listedColumns = await invoke("project", "column", "list", "--json");
    expect(listedColumns.code).toBe(0);
    expect(JSON.parse(listedColumns.stdout).map((column: { name: string }) => column.name)).toContain("Only DEF");
  });
});
