import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import cliPackageJson from "../../../../packages/cli/package.json" with { type: "json" };
import inspectorPackageJson from "../package.json" with { type: "json" };
import { activeTaskMap, parseTaskList, runZinn, zinnErrorReason } from "./data.ts";

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
    if (runsZinn && process.env["ZINN_DATA_TEST_SLEEP"] === "1") {
      return spawn(["sleep", "5"], options);
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
  delete process.env["ZINN_DATA_TEST_SLEEP"];
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
test("a read that passes its timeout fails instead of hanging", async () => {
  setEnvironment("ZINN_DATA_TEST_SLEEP", "1");
  const started = Date.now();
  const result = await runZinn(["task", "list", "--json"], 100);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("timed out");
  }
  expect(Date.now() - started).toBeLessThan(2_000);
});
test("whoami reports an inherited declaration before the inspector client", async () => {
  setEnvironment("ZINN_CLIENT", "rex/0.9");
  expect(await whoamiClient()).toBe(`${CLI_CLIENT} rex/0.9 ${INSPECTOR_CLIENT}`);
});
test("the active projection keeps active tasks and drops archived ones", () => {
  const parsed = parseTaskList(
    JSON.stringify([
      { key: "APP-1", title: "Active", status: "Active" },
      { key: "APP-2", title: "Archived", status: "Archived" },
    ]),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect([...activeTaskMap(parsed.value).keys()]).toEqual(["APP-1"]);
});
test("the task list keeps each task's column category", () => {
  const parsed = parseTaskList(
    JSON.stringify([{ key: "APP-1", title: "One", column: "Shipped", column_category: "done" }]),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.get("APP-1")?.columnCategory).toBe("done");
});
test("a task list without a column category leaves it unset", () => {
  const parsed = parseTaskList(
    JSON.stringify([
      { key: "APP-1", title: "One", column: "Done" },
      { key: "APP-2", title: "Two", column: "Done", column_category: null },
    ]),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.get("APP-1")?.columnCategory).toBeNull();
  expect(parsed.value.get("APP-2")?.columnCategory).toBeNull();
});
test("a task list keeps a live claim's holder identity and expiry", () => {
  const parsed = parseTaskList(
    JSON.stringify([
      {
        key: "APP-1",
        title: "One",
        claim: {
          state: "live",
          actor_session_id: "ses_root",
          actor_thread_id: "ses_child",
          renewed_at: 1_795_296_216_000,
          lease_ms: 1_800_000,
          expires_at: 1_795_296_216_313,
        },
      },
    ]),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.get("APP-1")?.claim).toEqual({
    state: "live",
    sessionId: "ses_root",
    threadId: "ses_child",
    renewedAt: 1_795_296_216_000,
    leaseMs: 1_800_000,
    expiresAt: 1_795_296_216_313,
  });
});
test("a missing claim is null", () => {
  const parsed = parseTaskList(JSON.stringify([{ key: "APP-1", title: "One", claim: null }]));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.get("APP-1")?.claim).toBeNull();
});
test("a malformed claim is dropped", () => {
  const parsed = parseTaskList(
    JSON.stringify([
      { key: "APP-1", title: "One", claim: { state: "pending" } },
      { key: "APP-2", title: "Two", claim: "live" },
      { key: "APP-3", title: "Three", claim: { state: 1 } },
      { key: "APP-4", title: "Four", claim: [] },
    ]),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  for (const key of ["APP-1", "APP-2", "APP-3", "APP-4"]) {
    expect(parsed.value.get(key)?.claim).toBeNull();
  }
});
test("an expired claim keeps its state", () => {
  const parsed = parseTaskList(
    JSON.stringify([
      {
        key: "APP-1",
        title: "One",
        claim: { state: "expired", actor_session_id: "ses_root", expires_at: 1_795_296_216_313 },
      },
    ]),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.get("APP-1")?.claim).toEqual({
    state: "expired",
    sessionId: "ses_root",
    threadId: null,
    renewedAt: null,
    leaseMs: null,
    expiresAt: 1_795_296_216_313,
  });
});
test("a task list without a claim field still parses", () => {
  const parsed = parseTaskList(JSON.stringify([{ key: "APP-1", title: "One" }]));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.get("APP-1")?.claim).toBeNull();
});
test("a non-numeric claim expiry leaves the expiry unset", () => {
  const parsed = parseTaskList(
    JSON.stringify([
      {
        key: "APP-1",
        title: "One",
        claim: { state: "live", actor_session_id: "ses_root", expires_at: "soon" },
      },
    ]),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.get("APP-1")?.claim).toEqual({
    state: "live",
    sessionId: "ses_root",
    threadId: null,
    renewedAt: null,
    leaseMs: null,
    expiresAt: null,
  });
});
test("a malformed claim renewal time or lease leaves both unset", () => {
  const parsed = parseTaskList(
    JSON.stringify([
      {
        key: "APP-1",
        title: "One",
        claim: {
          state: "live",
          actor_session_id: "ses_root",
          renewed_at: "yesterday",
          lease_ms: true,
        },
      },
    ]),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.get("APP-1")?.claim).toEqual({
    state: "live",
    sessionId: "ses_root",
    threadId: null,
    renewedAt: null,
    leaseMs: null,
    expiresAt: null,
  });
});
test("the error reason is read from the CLI envelope", () => {
  const envelope = JSON.stringify({
    error: {
      code: "conflict",
      details: {
        entity: "task",
        key: "APP-1",
        reason: "claimed",
        claimExpiresAt: 1_795_296_216_313,
      },
      message: "APP-1 is claimed by opencode (session ses_a)",
    },
  });
  expect(zinnErrorReason(envelope)).toBe("claimed");
});
test("a plain failure carries no reason", () => {
  expect(
    zinnErrorReason(
      JSON.stringify({ error: { code: "not_found", message: "APP-1 was not found" } }),
    ),
  ).toBeUndefined();
  expect(zinnErrorReason("not json")).toBeUndefined();
  expect(zinnErrorReason("")).toBeUndefined();
});
test("a refused heartbeat carries its reason on the result", async () => {
  expect((await runZinn(["project", "create", "ERR"])).ok).toBe(true);
  expect((await runZinn(["task", "create", "ERR", "--title", "No claim"])).ok).toBe(true);
  const result = await runZinn(["task", "heartbeat", "ERR-1", "--json"]);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe("conflict");
    expect(result.reason).toBe("not_claimed");
  }
});
