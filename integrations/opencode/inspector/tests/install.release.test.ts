import type { ArboristTree } from "@npmcli/arborist";

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { packInspector } from "./package-fixture.ts";

const install = async (tarball: string, directory: string, cache: string): Promise<ArboristTree> => {
  const { Arborist } = await import("@npmcli/arborist");
  const arborist = new Arborist({
    path: directory,
    cache,
    binLinks: true,
    progress: false,
    savePrefix: "",
    ignoreScripts: true,
    audit: false,
    windowsHide: true,
  });
  return arborist.reify({ add: [`file:${tarball}`], save: true, saveType: "prod" });
};

const versionAt = (tree: ArboristTree, location: string) => {
  for (const node of tree.inventory.values()) {
    if (node.location === location) {
      return node.package?.version;
    }
  }
  return undefined;
};

let fixture: ReturnType<typeof packInspector>;
beforeAll(() => {
  fixture = packInspector();
}, 120_000);
afterAll(() => {
  if (fixture !== undefined) {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("the packed inspector installs through the host's Arborist 9.4.0 resolver", async () => {
  const stage = join(fixture.directory, "release-stage");
  const cache = join(fixture.directory, "release-cache");
  mkdirSync(stage);
  const tree = await install(fixture.archive, stage, cache);

  expect(versionAt(tree, "node_modules/@zinn-dev/opencode")).toBe(fixture.manifest.version);
  expect(versionAt(tree, "node_modules/@opentui/core")).toBeUndefined();
  expect(versionAt(tree, "node_modules/@opentui/solid")).toBeUndefined();
  expect(versionAt(tree, "node_modules/solid-js")).toMatch(/^1\.9\./);
}, 120_000);

test("the old 0.5.0 peer ranges still fail the same resolver", async () => {
  const variant = join(fixture.directory, "old-ranges");
  mkdirSync(variant);
  const extracted = join(variant, "extracted");
  mkdirSync(extracted);
  expect(Bun.spawnSync(["tar", "-xzf", fixture.archive, "-C", extracted]).exitCode).toBe(0);

  const manifestPath = join(extracted, "package/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.peerDependencies["@opentui/core"] = ">=0.8.4 <0.9.0";
  manifest.peerDependencies["@opentui/solid"] = ">=0.8.4 <0.9.0";
  manifest.peerDependenciesMeta["@opentui/core"] = { optional: true };
  manifest.peerDependenciesMeta["@opentui/solid"] = { optional: true };
  manifest.peerDependencies["solid-js"] = ">=1.9.0";
  manifest.peerDependencies["effect"] = ">=4.0.1 <5";
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const archive = join(variant, "package.tgz");
  expect(Bun.spawnSync(["tar", "-czf", archive, "-C", extracted, "package"]).exitCode).toBe(0);

  const stage = join(fixture.directory, "old-ranges-stage");
  const cache = join(fixture.directory, "old-ranges-cache");
  mkdirSync(stage);

  let failure: { code?: string; message?: string } | undefined;
  try {
    await install(archive, stage, cache);
  } catch (error) {
    failure = error as { code?: string; message?: string };
  }

  expect(failure?.code).toBe("ERESOLVE");
}, 120_000);
