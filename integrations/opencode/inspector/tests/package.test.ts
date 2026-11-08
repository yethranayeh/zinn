import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installConsumer, packInspector, run } from "./package-fixture.ts";

let fixture: ReturnType<typeof packInspector>;
let consumer: ReturnType<typeof installConsumer>;
beforeAll(() => {
  fixture = packInspector();
  consumer = installConsumer(fixture);
}, 120_000);
afterAll(() => {
  if (fixture !== undefined) {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("the packed inspector installs independently with exact compatible OpenTUI peers", () => {
  const manifest = JSON.parse(readFileSync(join(consumer.installed, "package.json"), "utf8"));
  expect(manifest.name).toBe(fixture.manifest.name);
  expect(manifest.version).toBe(fixture.manifest.version);
  expect(manifest.exports).toEqual(fixture.manifest.exports);
  expect(manifest.exports["."]).toBe("./dist/index.js");
  expect(manifest.exports["./tui"]).toBe("./dist/tui.js");
  expect(manifest.exports["./gui-experimental"]).toBe("./dist/gui-experimental.cjs");
  expect(existsSync(join(consumer.installed, "dist/index.js"))).toBe(true);
  expect(existsSync(join(consumer.installed, "dist/tui.js"))).toBe(true);
  expect(existsSync(join(consumer.installed, "dist/gui-experimental.cjs"))).toBe(true);
  const gui = readFileSync(join(consumer.installed, "dist/gui-experimental.cjs"), "utf8");
  expect(gui.length).toBeGreaterThan(0);
  expect(gui).toContain("zinn.board");
  expect(existsSync(join(consumer.installed, "pkg/tui.tsx"))).toBe(false);
  expect(manifest.dependencies).toBeUndefined();
  expect(manifest.peerDependencies["@opencode/plugin"]).toBe("2.2.0");
  expect(manifest.peerDependenciesMeta["@opencode/plugin"]).toEqual({ optional: true });
  expect(manifest.peerDependencies["@opentui/core"]).toBe("0.7.0");
  expect(manifest.peerDependencies["@opentui/solid"]).toBe("0.7.0");
  expect(existsSync(join(consumer.consumer, "node_modules/@opencode/plugin"))).toBe(false);
  expect(fixture.members.some((path) => /test|NOTES|AGENTS|install\.sh|tsconfig|bun\.lock/.test(path))).toBe(false);
  const inspect = join(consumer.consumer, "dependencies.ts");
  writeFileSync(inspect, `for (const name of ["@opentui/core", "@opentui/solid"]) { console.log(JSON.parse(await Bun.file(new URL(import.meta.resolve(name + "/package.json"))).text()).version); }`);
  expect(run([process.execPath, inspect], consumer.consumer, consumer.env).trim().split("\n")).toEqual(["0.7.0", "0.7.0"]);
});

for (const version of ["0.41.0", "current"]) {
  test(`the installed inspector reads session and native thread contracts from CLI ${version}`, () => {
    const cli = version === "current" ? resolve(import.meta.dir, "../../../../packages/cli/index.ts") : consumer.releasedCLI;
    consumer.useCLI(cli);
    const env = { ...consumer.env, ZINN_DIR: join(fixture.directory, `store-${version}`) };
    mkdirSync(env.ZINN_DIR);
    const command = (args: string[], identity: Record<string, string> = {}) => JSON.parse(run([process.execPath, cli, ...args, "--json"], consumer.consumer, { ...env, ...identity }));
    command(["project", "create", "PKG"]);
    const explicit = command(["task", "create", "PKG", "--title", "Explicit session"], { ZINN_SESSION_ID: "ses_root" });
    const native = command(["task", "create", "PKG", "--title", "Native child"], { OPENCODE_SESSION_ID: "ses_child" });
    const unrelated = command(["task", "create", "PKG", "--title", "Other conversation"], { OPENCODE_SESSION_ID: "ses_other" });
    const probe = join(consumer.consumer, "contracts.ts");
    writeFileSync(probe, `import {probeAnySession} from ${JSON.stringify(join(consumer.installed, "dist/session.js"))};\nconsole.log(JSON.stringify(await Promise.all(${JSON.stringify([explicit.key, native.key, unrelated.key])}.map(key => probeAnySession(["ses_root", "ses_child"], key)))));\n`);
    expect(JSON.parse(run([process.execPath, probe], consumer.consumer, env))).toEqual([
      { mine: true, unsupported: false }, { mine: true, unsupported: false }, { mine: false, unsupported: false },
    ]);
  });
}

test("OpenCode 2.2.0 loads the extracted artifact, opens picker and detail, and applies update and removal", async () => {
  const { verifyHost } = await import("./host-fixture.ts");
  consumer.useCLI(consumer.releasedCLI);
  run([process.execPath, consumer.releasedCLI, "project", "create", "PKG", "--json"], consumer.consumer, consumer.env);
  for (const title of ["Package inspector detail", "Other conversation", "Completed task"]) {
    run([process.execPath, consumer.releasedCLI, "task", "create", "PKG", "--title", title, "--json"], consumer.consumer, consumer.env);
  }
  const result = await verifyHost(fixture, consumer);
  expect(result.version).toBe("2.2.0");
  expect(result.frames).toHaveLength(3);
}, 120_000);
