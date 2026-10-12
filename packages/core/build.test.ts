import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../..", import.meta.url));
const outputDirectory = join(packageDirectory, "dist");
const BUILD_CHECK_TIMEOUT_MS = 30_000;

function run(command: string[]) {
  const result = Bun.spawnSync(command, { cwd: repositoryDirectory });
  expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(0);
  return result.stdout.toString();
}

test("emitted core works on both runtimes and its declarations need no Bun types", () => {
  // A development build must discard identity left by an earlier release build.
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "release-stamp.json"), '{"release":"published"}');
  writeFileSync(join(outputDirectory, "package.json"), '{"version":"1.0.0","type":"module"}');
  run(["bun", "run", "--cwd", packageDirectory, "build"]);
  const directory = mkdtempSync(join(tmpdir(), "zinn-core-build-"));
  const outputUrl = (path: string) => pathToFileURL(join(outputDirectory, path)).href;

  try {
    // Reuse the adapter contract against the emitted wrapper, including its error class.
    const contractSource = readFileSync(join(packageDirectory, "src/sqlite/contract.ts"), "utf8")
      .replaceAll('"./database.ts"', JSON.stringify(outputUrl("src/sqlite/database.js")));
    const contract = new Bun.Transpiler({ loader: "ts" }).transformSync(contractSource);
    writeFileSync(join(directory, "contract.mjs"), contract);

    const runtimeCheck = join(directory, "runtime.test.mjs");
    writeFileSync(runtimeCheck, `
      import { test } from "node:test";
      import { strict as assert } from "node:assert";
      import { defineContractChecks } from "./contract.mjs";
      import * as core from ${JSON.stringify(outputUrl("index.js"))};
      import { getDb } from ${JSON.stringify(outputUrl("src/db.js"))};
      import { readCoreReleaseMode } from ${JSON.stringify(outputUrl("src/release.js"))};
      const adapterPath = typeof Bun === "undefined" ? "node" : "bun";
      const adapter = await import(${JSON.stringify(outputUrl("src/sqlite/"))} + adapterPath + ".js");
      defineContractChecks(test, adapter);

      test("emitted public API uses the runtime adapter and retains source identity", () => {
        process.env.ZINN_DIR = ${JSON.stringify(join(directory, "store"))} + "-" + adapterPath;
        assert.equal(readCoreReleaseMode(), "source");
        core.configureDatabase({ client: "build check", version: "1.0.0", executable: "runtime.test.mjs", release: "published", allowsLegacyRead: false });
        const actor = { name: "build check", email: "build@example.test", kind: "agent" };
        const createdProject = core.project.create({ key: "BUILD" }, actor);
        const createdTask = core.task.create({ project_id: createdProject.id, title: "Emitted JavaScript" }, actor);
        core.comment.create({ taskKey: createdTask.key, text: "searchable comment" }, actor);
        assert.equal(createdTask.key, "BUILD-1");
        assert.equal(core.task.search({ query: "searchable" }).tasks[0].id, createdTask.id);
        assert.equal(core.task.getByKey(createdTask.key).title, "Emitted JavaScript");
        assert.throws(() => core.task.create({ project_id: createdProject.id, title: "invalid", priority: "invalid" }, actor));
        assert.equal(core.task.getAll({ projectKey: createdProject.key }).length, 1);
        const db = getDb();
        assert.equal(db.query("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), []);
        db.close();
      });
    `);

    run(["bun", "test", runtimeCheck]);
    run(["bun", "run", "test:node", runtimeCheck]);

    writeFileSync(join(directory, "consumer.mts"), `
      import { project, task, configureDatabase, type Actor, type TaskWithKey } from "@zinn-dev/core";
      const actor: Actor = { name: "consumer", email: "consumer@example.test", kind: "human" };
      configureDatabase({ client: "consumer", version: "1.0.0", executable: "consumer.mts", release: "source", allowsLegacyRead: false });
      const createdProject = project.create({ key: "TYPES" }, actor);
      const createdTask: TaskWithKey = task.create({ project_id: createdProject.id, title: "Declarations", priority: "high" }, actor);
      const key: string = createdTask.key;
      // @ts-expect-error priority is a public vocabulary, not an arbitrary string.
      task.create({ project_id: createdProject.id, title: "Invalid", priority: "invalid" }, actor);
      // @ts-expect-error every mutation requires an explicit actor.
      project.create({ key: "INVALID" });
    `);
    const consumerConfig = join(directory, "tsconfig.json");
    writeFileSync(consumerConfig, JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        // Zod's declarations reference the standard URL type.
        lib: ["ES2023", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: [],
        paths: { "@zinn-dev/core": [join(outputDirectory, "index.d.ts")] },
      },
      files: ["consumer.mts"],
    }));
    const checkedFiles = run(["bunx", "--no-install", "tsc", "-p", consumerConfig, "--listFiles"]);
    expect(checkedFiles).not.toContain("bun-types");
    expect(checkedFiles).not.toContain("@types/bun");
    expect(checkedFiles).not.toContain("@types/node");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, BUILD_CHECK_TIMEOUT_MS);
