import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import cliPackageJson from "../../../../packages/cli/package.json" with { type: "json" };
import inspectorPackageJson from "../package.json" with { type: "json" };
import { runZinn } from "./data.ts";

const CLI_CLIENT = `zinn-cli/${cliPackageJson.version}`;
const INSPECTOR_CLIENT = `zinn-opencode:inspector/${inspectorPackageJson.version}`;
const directory = mkdtempSync(join(tmpdir(), "zinn-panel-data-"));
const store = join(directory, "store");
const cli = resolve(import.meta.dir, "../../../../packages/cli/index.ts");
const originalEnv = { ZINN_CLIENT: process.env["ZINN_CLIENT"], ZINN_DIR: process.env["ZINN_DIR"] };
const spawn = Bun.spawn;
const spawnEnvironments: Array<Record<string, string | undefined>> = [];
let restoreSpawn: (() => void) | undefined;

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
function lastSpawnEnvironment(): Record<string, string | undefined> {
  expect(spawnEnvironments.length).toBeGreaterThan(0);
  return spawnEnvironments.at(-1) ?? {};
}
async function whoamiClient(): Promise<string> {
  const result = await runZinn(["whoami", "--json"]);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return "";
  }
  const actor = JSON.parse(result.value) as { actor_client: string };
  return actor.actor_client;
}
beforeAll(() => {
  mkdirSync(store);
  const mock = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const runsZinn = cmd[0] === "zinn";
    if (runsZinn) {
      spawnEnvironments.push((options?.env ?? {}) as Record<string, string | undefined>);
    }
    return spawn(runsZinn ? [process.execPath, cli, ...cmd.slice(1)] : cmd, options);
  }) as typeof Bun.spawn);
  restoreSpawn = () => mock.mockRestore();
});
beforeEach(() => {
  spawnEnvironments.length = 0;
  setEnvironment("ZINN_DIR", store);
});
afterEach(() => {
  setEnvironment("ZINN_DIR", originalEnv.ZINN_DIR);
  setEnvironment("ZINN_CLIENT", originalEnv.ZINN_CLIENT);
  delete process.env["ZINN_DATA_TEST_MARKER"];
});
afterAll(() => {
  restoreSpawn?.();
  rmSync(directory, { recursive: true, force: true });
});
test("the inspector declares its client when nothing is inherited", async () => {
  setEnvironment("ZINN_CLIENT", undefined);
  expect((await runZinn(["whoami", "--json"])).ok).toBe(true);
  expect(lastSpawnEnvironment()["ZINN_CLIENT"]).toBe(INSPECTOR_CLIENT);
});
test("the inspector appends its client to an inherited declaration", async () => {
  setEnvironment("ZINN_CLIENT", "rex/0.9");
  expect((await runZinn(["whoami", "--json"])).ok).toBe(true);
  expect(lastSpawnEnvironment()["ZINN_CLIENT"]).toBe(`rex/0.9 ${INSPECTOR_CLIENT}`);
});
test("a whitespace-only declaration leaves only the inspector client", async () => {
  setEnvironment("ZINN_CLIENT", "  \t ");
  expect((await runZinn(["whoami", "--json"])).ok).toBe(true);
  expect(lastSpawnEnvironment()["ZINN_CLIENT"]).toBe(INSPECTOR_CLIENT);
});
test("an inherited declaration is trimmed and other environment variables pass through", async () => {
  setEnvironment("ZINN_CLIENT", "  rex/0.9  ");
  setEnvironment("ZINN_DATA_TEST_MARKER", "kept");
  expect((await runZinn(["whoami", "--json"])).ok).toBe(true);
  const environment = lastSpawnEnvironment();
  expect(environment["ZINN_CLIENT"]).toBe(`rex/0.9 ${INSPECTOR_CLIENT}`);
  expect(environment["ZINN_DATA_TEST_MARKER"]).toBe("kept");
});
test("whoami reports the CLI and inspector clients when nothing is inherited", async () => {
  setEnvironment("ZINN_CLIENT", undefined);
  expect(await whoamiClient()).toBe(`${CLI_CLIENT} ${INSPECTOR_CLIENT}`);
});
test("whoami reports an inherited declaration before the inspector client", async () => {
  setEnvironment("ZINN_CLIENT", "rex/0.9");
  expect(await whoamiClient()).toBe(`${CLI_CLIENT} rex/0.9 ${INSPECTOR_CLIENT}`);
});
