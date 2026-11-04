import type { SchemaSnapshot } from "./schema-pins.ts";

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applicationSchema } from "./schema-objects.ts";

// Usage: bun packages/core/testing/capture-schema.ts SOURCE COMMIT OUTPUT [PENDING_PATH...]
const [sourceArgument, commit, output, ...pendingPaths] = process.argv.slice(2);
assert.ok(sourceArgument && commit && output, "Expected SOURCE COMMIT OUTPUT [PENDING_PATH...]");
assert.match(commit, /^[a-f0-9]{40}$/);
const source = realpathSync(sourceArgument);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
assert.notEqual(source, realpathSync(repository), "Capture requires an isolated source tree");
assert.equal(existsSync(output), false, "A schema snapshot already exists at the output path");

function git(args: Array<string>) {
  const result = Bun.spawnSync(["git", "-C", repository, ...args]);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout;
}

assert.equal(
  git(["rev-parse", `${commit}^{commit}`])
    .toString()
    .trim(),
  commit,
);

const sourcePaths = new Set([
  "packages/core/package.json",
  ...git(["ls-tree", "-r", "--name-only", commit, "packages/core/src"])
    .toString()
    .trim()
    .split("\n"),
  ...Array.from(new Bun.Glob("packages/core/src/**/*").scanSync({ cwd: source, onlyFiles: true })),
]);

const pending = new Set(pendingPaths);
for (const path of pending) {
  assert.ok(sourcePaths.has(path), `Pending input is outside the captured core source: ${path}`);
}

const pendingSchemaInputs: NonNullable<SchemaSnapshot["pendingSchemaInputs"]> = [];
for (const path of [...sourcePaths].sort()) {
  const localPath = resolve(source, path);
  assert.ok(localPath.startsWith(source + "/"));
  const historical: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync([
    "git",
    "-C",
    repository,
    "show",
    `${commit}:${path}`,
  ]);

  const contents = existsSync(localPath) ? readFileSync(localPath) : null;
  const matchesCommit: boolean =
    historical.exitCode === 0 && contents !== null && contents.equals(historical.stdout);

  if (pending.has(path)) {
    assert.equal(matchesCommit, false, `Pending input is unchanged from the base commit: ${path}`);
    pendingSchemaInputs.push({
      path,
      sha256: contents === null ? null : createHash("sha256").update(contents).digest("hex"),
    });
  } else {
    assert.ok(
      matchesCommit,
      `Source differs from ${commit}: ${path}. Identify pending inputs explicitly`,
    );
  }
}

const historicalModule = (path: string) =>
  import(pathToFileURL(join(source, "packages/core/src", path)).href);
const { openDatabase } = await historicalModule("sqlite/bun.ts");
const { createSchema, readSchemaVersion } = await historicalModule("migrations/runner.ts");
const manifest = JSON.parse(readFileSync(join(source, "packages/core/package.json"), "utf8"));
const db = openDatabase(":memory:");

try {
  createSchema(db);
  const snapshot: SchemaSnapshot = {
    schemaVersion: readSchemaVersion(db),
    packageVersion: manifest.version,
    sourceCommit: commit,
    ...(pendingSchemaInputs.length === 0 ? {} : { pendingSchemaInputs }),
    objects: applicationSchema(db),
  };
  writeFileSync(output, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" });
  console.log(
    `Captured schema v${snapshot.schemaVersion} from core ${snapshot.packageVersion} at ${output}`,
  );
} finally {
  db.close();
}
