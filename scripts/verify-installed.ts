/** Checks installed release artifacts before pnpm publishes either package. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageFixture, PACKAGE_NAMES, readNodeMinimum } from "./package-fixture.ts";

const REPOSITORY_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const PARALLEL_CREATES = 8;
const METADATA_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
const ARCHIVE_TIMEOUT_MS = 600_000;
const NODE_CACHE_DIRECTORY = join(homedir(), ".cache", "zinn", "node");

// A publish dry-run still needs real local tarballs and a real consumer install.
const TOOL_ENVIRONMENT = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "npm_config_dry_run"),
);

type Runtime = { name: string; executable: string; adapter: "node" | "bun"; path: string };
type CommandResult = { code: number; stdout: string; stderr: string };

async function run(
  command: string[],
  cwd: string,
  env = TOOL_ENVIRONMENT,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (stderr.trim()) {
      console.log(`stderr (${command.join(" ")}):\n${stderr.trimEnd()}`);
    }

    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function succeeds(
  command: string[],
  cwd: string,
  env = TOOL_ENVIRONMENT,
  timeoutMs = COMMAND_TIMEOUT_MS,
) {
  const result = await run(command, cwd, env, timeoutMs);
  assert.equal(result.code, 0, `${command.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);

  return result.stdout;
}

async function download(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
    assert.ok(response.ok, `${url}: HTTP ${response.status}`);

    return response;
  } catch (error) {
    throw new Error(`Could not download ${url}`, { cause: error });
  }
}

async function nodeRuntimes(
  directory: string,
  minimum: ReturnType<typeof readNodeMinimum>,
): Promise<Runtime[]> {
  assert.equal(process.platform, "darwin", "Installed-package verification requires macOS.");
  console.log("Selecting maintained Node releases from the official schedule and release index...");

  const [schedule, releases] = await Promise.all([
    download("https://raw.githubusercontent.com/nodejs/Release/main/schedule.json").then(
      (response) => response.json(),
    ) as Promise<Record<string, { start: string; end: string }>>,

    download("https://nodejs.org/dist/index.json").then((response) => response.json()) as Promise<
      Array<{ version: string; files: string[] }>
    >,
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const versions = new Set([minimum.version]);

  for (const [line, dates] of Object.entries(schedule)) {
    const major = Number(line.slice(1));
    const isSupportedLine = major >= minimum.major && dates.start <= today && today < dates.end;
    if (isSupportedLine) {
      const latest = releases.find((release) =>
        new RegExp(`^v${major}\\.\\d+\\.\\d+$`).test(release.version),
      );
      assert.ok(latest, `No stable Node release found for ${line}`);
      versions.add(latest.version.slice(1));
    }
  }

  mkdirSync(NODE_CACHE_DIRECTORY, { recursive: true });
  console.log(`Node versions: ${[...versions].join(", ")}; archive cache: ${NODE_CACHE_DIRECTORY}`);

  const runtimes: Runtime[] = [];
  for (const version of versions) {
    const archiveName = `node-v${version}-darwin-${process.arch}.tar.xz`;
    const releaseUrl = `https://nodejs.org/dist/v${version}`;
    const sums = await (await download(`${releaseUrl}/SHASUMS256.txt`)).text();
    const expectedHash = sums
      .split("\n")
      .find((line) => line.trim().split(/\s+/)[1] === archiveName)
      ?.split(/\s+/)[0];
    assert.ok(expectedHash, `No official checksum for ${archiveName}`);
    const archivePath = join(NODE_CACHE_DIRECTORY, archiveName);
    console.log(`${existsSync(archivePath) ? "Checking cached" : "Downloading"} ${archiveName}...`);
    const temporaryArchive = join(directory, archiveName);

    if (!existsSync(archivePath)) {
      await succeeds(
        [
          "/usr/bin/curl",
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--max-time",
          String(ARCHIVE_TIMEOUT_MS / 1000),
          "--output",
          temporaryArchive,
          `${releaseUrl}/${archiveName}`,
        ],
        directory,
        TOOL_ENVIRONMENT,
        ARCHIVE_TIMEOUT_MS,
      );
    }

    const archive = readFileSync(existsSync(archivePath) ? archivePath : temporaryArchive);
    assert.equal(
      createHash("sha256").update(archive).digest("hex"),
      expectedHash,
      `Checksum mismatch: ${archiveName}`,
    );
    console.log(`PASS SHA256 ${archiveName}`);

    if (!existsSync(archivePath)) {
      writeFileSync(archivePath, archive);
    }

    // Extract the checked archive afresh rather than trusting an earlier executable.
    await succeeds(["/usr/bin/tar", "-xzf", archivePath, "-C", directory], directory);
    const executable = join(directory, archiveName.replace(/\.tar\.xz$/, ""), "bin", "node");
    const path = `${dirname(executable)}:/usr/bin:/bin`;
    assert.ok(
      !path.split(":").some((entry) => existsSync(join(entry, "bun"))),
      "Node check PATH contains Bun",
    );
    assert.equal((await succeeds([executable, "--version"], directory)).trim(), `v${version}`);
    runtimes.push({ name: `Node ${version}`, executable, adapter: "node", path });
  }

  return runtimes;
}

async function installPackages(root: string) {
  const repository = join(root, "repository");
  createPackageFixture(REPOSITORY_DIRECTORY, repository);

  const coreDirectory = join(repository, "packages", "core");

  const tarballs = join(root, "tarballs");
  mkdirSync(tarballs);

  const archives: Record<string, string> = {};
  for (const name of PACKAGE_NAMES) {
    const directory = join(repository, "packages", name);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    // Preserve the release versions; development fixtures must finalize their own copies.
    await succeeds(["pnpm", "pack", "--dry-run=false", "--pack-destination", tarballs], directory);
    archives[name] = join(tarballs, `zinn-dev-${name}-${manifest.version}.tgz`);
  }

  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@zinn-dev/core": `file:${archives.core}`,
        "@zinn-dev/cli": `file:${archives.cli}`,
      },
      pnpm: { overrides: { "@zinn-dev/core": `file:${archives.core}` } },
    }),
  );

  await succeeds(["pnpm", "install", "--ignore-scripts"], consumer);
  const installedCore = realpathSync(join(consumer, "node_modules/@zinn-dev/core"));
  const installedCli = realpathSync(join(consumer, "node_modules/@zinn-dev/cli"));

  assert.equal(
    realpathSync(join(installedCli, "../core")),
    installedCore,
    "CLI did not receive the packed core",
  );

  assert.deepEqual(
    JSON.parse(readFileSync(join(installedCore, "package.json"), "utf8")),
    JSON.parse(readFileSync(join(coreDirectory, "release-dist/package.json"), "utf8")),
  );
  console.log(`PASS installed CLI resolves packed core: ${installedCore}`);

  return { consumer, installedCore, installedCli };
}

async function checkRuntime(
  runtime: Runtime,
  root: string,
  consumer: string,
  installedCli: string,
) {
  const directory = join(root, runtime.adapter + "-" + runtime.name.replaceAll(" ", "-"));
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });

  // Runtime commands receive no inherited flags, warning suppression, preload, or module paths.
  const env = { HOME: home, ZINN_DIR: join(directory, "store"), PATH: runtime.path };
  const prefix = `[${runtime.name}]`;
  const coreCheck = join(consumer, "core-check.mjs");
  writeFileSync(
    coreCheck,
    `
    import { strict as assert } from "node:assert";
    import { fileURLToPath } from "node:url";
    import * as core from "@zinn-dev/core";
    const coreUrl = import.meta.resolve("@zinn-dev/core");
    const { getDb } = await import(new URL("src/db.js", coreUrl));
    const { driver } = await import(new URL("src/sqlite/${runtime.adapter}.js", coreUrl));
    core.configureDatabase({ client: "installed check", version: "1.0.0", executable: "core-check.mjs", release: "published", allowsLegacyRead: false });
    const actor = { name: "installed check", email: "check@example.test", kind: "agent" };
    const project = core.project.create({ key: "CORE" }, actor);
    const task = core.task.create({ project_id: project.id, title: "Installed core" }, actor);
    assert.equal(core.task.getByKey(task.key).title, "Installed core");
    assert.equal(getDb().driver, driver, "Core selected the wrong SQLite adapter");
    getDb().close();
    console.log(JSON.stringify({ adapter: ${JSON.stringify(runtime.adapter)}, core: fileURLToPath(coreUrl) }));
  `,
  );

  const coreResult = JSON.parse(await succeeds([runtime.executable, coreCheck], consumer, env));
  assert.equal(coreResult.adapter, runtime.adapter);
  console.log(`${prefix} PASS core domain operation and ${runtime.adapter} SQLite adapter`);

  const manifest = JSON.parse(readFileSync(join(installedCli, "package.json"), "utf8"));
  const bin = join(consumer, "node_modules/.bin/zinn");
  const command =
    runtime.adapter === "node"
      ? [bin]
      : [runtime.executable, join(installedCli, manifest.bin.zinn)];
  const cli = (args: string[]) => succeeds([...command, ...args], consumer, env);
  assert.equal((await cli(["--version"])).trim(), manifest.version);
  assert.equal(JSON.parse(await cli(["project", "create", "CLI", "--json"])).key, "CLI");

  const task = JSON.parse(
    await cli(["task", "create", "CLI", "--title", "Installed CLI", "--json"]),
  );
  assert.equal(task.key, "CLI-1");

  const list = JSON.parse(await cli(["task", "list", "CLI", "--json"]));
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Installed CLI");
  console.log(`${prefix} PASS installed bin version, project/task creation and JSON list`);

  for (const flags of [[], ["--json"]]) {
    const failed = await run([...command, "task", "view", "CLI-999999", ...flags], consumer, env);
    assert.notEqual(failed.code, 0);
    assert.equal(failed.stdout, "");
    assert.ok(
      failed.stderr.includes("CLI-999999"),
      "Failure stderr does not identify the missing task",
    );
  }
  console.log(`${prefix} PASS error exit, stderr and empty stdout with/without --json`);

  const backup = JSON.parse(await cli(["backup", "--json"]));
  assert.ok(existsSync(backup.path), "Backup JSON does not point to a created snapshot");
  console.log(`${prefix} PASS backup JSON and snapshot`);

  const concurrent = await Promise.all(
    Array.from({ length: PARALLEL_CREATES }, (_, index) =>
      run(
        [...command, "task", "create", "CLI", "--title", `Parallel ${index}`, "--json"],
        consumer,
        env,
      ),
    ),
  );
  const keys = concurrent.map((result) => {
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout).key;
  });
  const after = JSON.parse(await cli(["task", "list", "CLI", "--json"]));

  assert.equal(new Set(keys).size, PARALLEL_CREATES);
  assert.equal(after.length, list.length + PARALLEL_CREATES);

  for (const key of keys) {
    assert.ok(after.some((task: { key: string }) => task.key === key));
  }

  console.log(
    `${prefix} PASS ${PARALLEL_CREATES} parallel creates and exactly ${PARALLEL_CREATES} new tasks`,
  );
}

async function checkDeclarations(consumer: string) {
  writeFileSync(
    join(consumer, "consumer.mts"),
    `
    import { project, task, configureDatabase, type Actor, type TaskWithKey } from "@zinn-dev/core";
    const actor: Actor = { name: "consumer", email: "consumer@example.test", kind: "human" };
    configureDatabase({ client: "consumer", version: "1.0.0", executable: "consumer.mts", release: "source", allowsLegacyRead: false });
    const createdProject = project.create({ key: "TYPES" }, actor);
    const createdTask: TaskWithKey = task.create({ project_id: createdProject.id, title: "Declarations", priority: "high" }, actor);
    const key: string = createdTask.key;
    // @ts-expect-error public priorities are a vocabulary.
    task.create({ project_id: createdProject.id, title: "Invalid", priority: "invalid" }, actor);
    // @ts-expect-error mutations require an actor.
    project.create({ key: "INVALID" });
  `,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        lib: ["ES2023", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: [],
      },
      files: ["consumer.mts"],
    }),
  );
  const compiler = join(REPOSITORY_DIRECTORY, "node_modules/typescript/bin/tsc");
  const checkedFiles = await succeeds(
    [process.execPath, compiler, "-p", join(consumer, "tsconfig.json"), "--listFiles"],
    consumer,
  );

  assert.ok(checkedFiles.includes("index.d.ts"));
  assert.ok(!/bun-types|@types\/bun/.test(checkedFiles), "Consumer loaded Bun's types");
  console.log("PASS installed core declarations: strict TypeScript consumer without Bun types");
}

const root = mkdtempSync(join(tmpdir(), "zinn-installed-"));
try {
  const minimum = readNodeMinimum(REPOSITORY_DIRECTORY);
  console.log(
    `Installed release verification: ${process.platform} ${release()} ${process.arch}, Bun ${Bun.version}, pnpm ${(await succeeds(["pnpm", "--version"], REPOSITORY_DIRECTORY)).trim()}`,
  );

  const { consumer, installedCli } = await installPackages(root);
  const runtimeDirectory = join(root, "runtimes");
  mkdirSync(runtimeDirectory);

  const runtimes = await nodeRuntimes(runtimeDirectory, minimum);
  runtimes.push({
    name: `Bun ${Bun.version}`,
    executable: process.execPath,
    adapter: "bun",
    path: `${dirname(process.execPath)}:/usr/bin:/bin`,
  });

  for (const runtime of runtimes) {
    await checkRuntime(runtime, root, consumer, installedCli);
  }

  await checkDeclarations(consumer);
  console.log("PASS installed release verification; publish may proceed");
} catch (error) {
  console.error("Installed release verification failed; publish aborted.", error);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
