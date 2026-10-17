/** Checks locally packed core and CLI on Node and Bun before publishing. */
import { strict as assert } from "node:assert";
import {
  copyFileSync,
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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createPackageTestCopy, PACKAGE_NAMES, readNodeMinimum } from "./package-fixture.ts";
import { readVerifiedDownload } from "./archive-cache.ts";

const REPOSITORY_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_CHECKS_DIRECTORY = join(REPOSITORY_DIRECTORY, "packages/core/package-checks");
const PARALLEL_CREATES = 8;
const METADATA_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
const NODE_DOWNLOAD_TIMEOUT_MS = 600_000;
const NODE_DOWNLOAD_CACHE_DIRECTORY = join(homedir(), ".cache", "zinn", "node");

// Even during a publish dry-run, build package files and install them for testing.
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

async function prepareNodeRuntimes(
  directory: string,
  minimum: ReturnType<typeof readNodeMinimum>,
): Promise<Runtime[]> {
  assert.equal(process.platform, "darwin", "Installed-package verification requires macOS.");
  console.log(
    "Selecting Node versions to test: the package minimum and maintained release lines...",
  );

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

  console.log(
    `Node versions: ${[...versions].join(", ")}; downloaded Node files: ${NODE_DOWNLOAD_CACHE_DIRECTORY}`,
  );

  const runtimes: Runtime[] = [];
  for (const version of versions) {
    const nodeDownloadName = `node-v${version}-darwin-${process.arch}.tar.xz`;

    const releaseUrl = `https://nodejs.org/dist/v${version}`;
    const sums = await (await download(`${releaseUrl}/SHASUMS256.txt`)).text();
    const expectedHash = sums
      .split("\n")
      .find((line) => line.trim().split(/\s+/)[1] === nodeDownloadName)
      ?.split(/\s+/)[0];
    assert.ok(expectedHash, `No official checksum for ${nodeDownloadName}`);

    const nodeDownloadPath = join(NODE_DOWNLOAD_CACHE_DIRECTORY, nodeDownloadName);

    console.log(`Checking Node download ${nodeDownloadName}...`);
    await readVerifiedDownload(nodeDownloadPath, expectedHash, async (temporaryDownloadPath) => {
      console.log(`Downloading Node: ${nodeDownloadName}...`);
      await succeeds(
        [
          "/usr/bin/curl",
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--max-time",
          String(NODE_DOWNLOAD_TIMEOUT_MS / 1000),
          "--output",
          temporaryDownloadPath,
          `${releaseUrl}/${nodeDownloadName}`,
        ],
        directory,
        TOOL_ENVIRONMENT,
        NODE_DOWNLOAD_TIMEOUT_MS,
      );
    });
    console.log(`PASS Node download matches its official SHA256 checksum: ${nodeDownloadName}`);

    // Unpack the verified Node download for this test run.
    await succeeds(["/usr/bin/tar", "-xf", nodeDownloadPath, "-C", directory], directory);

    const executable = join(directory, nodeDownloadName.replace(/\.tar\.xz$/, ""), "bin", "node");
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

async function installPackedZinnPackages(root: string) {
  console.log(
    "Building and packing Zinn in a temporary copy, then installing it in an empty test folder...",
  );
  const repository = join(root, "repository");
  createPackageTestCopy(REPOSITORY_DIRECTORY, repository);

  const coreDirectory = join(repository, "packages", "core");

  const tarballs = join(root, "tarballs");
  mkdirSync(tarballs);

  const packageTarballs: Record<string, string> = {};
  for (const name of PACKAGE_NAMES) {
    const directory = join(repository, "packages", name);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    // Pack the existing versions; release preparation rejects development versions.
    await succeeds(["pnpm", "pack", "--dry-run=false", "--pack-destination", tarballs], directory);
    packageTarballs[name] = join(tarballs, `zinn-dev-${name}-${manifest.version}.tgz`);
  }

  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@zinn-dev/core": `file:${packageTarballs.core}`,
        "@zinn-dev/cli": `file:${packageTarballs.cli}`,
      },
      pnpm: { overrides: { "@zinn-dev/core": `file:${packageTarballs.core}` } },
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
  console.log(`PASS installed CLI uses the core package built for this check: ${installedCore}`);

  const coreZod = realpathSync(
    createRequire(join(installedCore, "package.json")).resolve("zod/package.json"),
  );
  const cliZod = realpathSync(
    createRequire(join(installedCli, "package.json")).resolve("zod/package.json"),
  );

  assert.equal(cliZod, coreZod, "Installed CLI and core resolved different Zod copies");
  assert.equal(
    JSON.parse(readFileSync(cliZod, "utf8")).version,
    JSON.parse(readFileSync(join(installedCli, "package.json"), "utf8")).dependencies.zod,
  );
  console.log("PASS installed CLI and core share their declared Zod version");

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
  const coreCheck = join(consumer, "runtime.mjs");
  copyFileSync(join(PACKAGE_CHECKS_DIRECTORY, "runtime.mjs"), coreCheck);

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

    if (flags.includes("--json")) {
      const failure = JSON.parse(failed.stderr).error;
      assert.equal(failure.code, "not_found");
      assert.equal(failure.details.entity, "task");
      assert.equal(failure.details.key, "CLI-999999");
    }
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
  copyFileSync(join(PACKAGE_CHECKS_DIRECTORY, "consumer.mts"), join(consumer, "consumer.mts"));
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
  console.log("Checking that installed Zinn works on Node without Bun, and on Bun.");
  console.log(
    `Test environment: ${process.platform} ${release()} ${process.arch}, Bun ${Bun.version}, pnpm ${(await succeeds(["pnpm", "--version"], REPOSITORY_DIRECTORY)).trim()}`,
  );

  const { consumer, installedCli } = await installPackedZinnPackages(root);
  const runtimeDirectory = join(root, "runtimes");
  mkdirSync(runtimeDirectory);

  const runtimes = await prepareNodeRuntimes(runtimeDirectory, minimum);
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
  console.log("PASS installed Zinn checks; publishing may proceed");
} catch (error) {
  console.error("Installed Zinn checks failed; publishing stopped.", error);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
