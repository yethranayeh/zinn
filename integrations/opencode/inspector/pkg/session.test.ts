import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEST_ENVIRONMENT } from "../../../../scripts/test-isolation.ts";
import { ACTIVITY_MARK_TTL_MS, PROBE_RECHECK_MS, isRecentActivity, probeAnySession, probeSessions, probeSessionTask, runPool, sessionRunning, shouldProbe } from "./session.ts";
type Context = Parameters<typeof probeSessions>[0];
const directory = mkdtempSync(join(tmpdir(), "zinn-panel-session-"));
const store = join(directory, "store");
const bin = join(directory, "bin");
const executable = join(bin, "zinn");
const cli = resolve(import.meta.dir, "../../../../packages/cli/index.ts");
const spawn = Bun.spawn;
let restoreSpawn: (() => void) | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const wrapper = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`;
function command(session: string, args: string[]) {
  const result = Bun.spawnSync([process.execPath, cli, ...args, "--json"], {
    env: { ...TEST_ENVIRONMENT, ZINN_DIR: store, ZINN_SESSION_ID: session, ZINN_AGENT: "opencode" },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}
beforeAll(() => {
  mkdirSync(bin);
  mkdirSync(store);
  writeFileSync(executable, wrapper);
  chmodSync(executable, 0o755);
  const mock = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    return spawn(cmd[0] === "zinn" ? [executable, ...cmd.slice(1)] : cmd, {
      ...options,
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: store },
    });
  }) as typeof Bun.spawn);
  restoreSpawn = () => mock.mockRestore();
  command("ses_root", ["project", "create", "PANEL"]);
  command("ses_child", ["task", "create", "PANEL", "--title", "Child session work"]);
  command("ses_other", ["task", "create", "PANEL", "--title", "Other session work", "--description", "meta.session: ses_root"]);
});
afterEach(() => {
  writeFileSync(executable, wrapper);
});
afterAll(() => {
  restoreSpawn?.();
  rmSync(directory, { recursive: true, force: true });
});
test("native activity associates a task without description metadata with its session", async () => {
  expect(await probeSessionTask("ses_child", "PANEL-1")).toEqual({ at: expect.any(Number), unsupported: false });
  expect(await probeSessionTask("ses_root", "PANEL-1")).toEqual({ at: null, unsupported: false });
  expect(await probeSessionTask("SES_CHILD", "PANEL-1")).toEqual({ at: null, unsupported: false });
});
test("a misleading description footer does not associate another session's task", async () => {
  expect(await probeSessionTask("ses_root", "PANEL-2")).toEqual({ at: null, unsupported: false });
  expect(await probeSessionTask("ses_other", "PANEL-2")).toEqual({ at: expect.any(Number), unsupported: false });
});
test("a later native write associates an already existing task", async () => {
  expect((await probeSessionTask("ses_later", "PANEL-1")).at).toBeNull();
  command("ses_later", ["task", "comment", "create", "PANEL-1", "--text", "Verified the result"]);
  expect((await probeSessionTask("ses_later", "PANEL-1")).at).toBeNumber();
});
test("session-family attribution includes a child's native writes and excludes unrelated sessions", async () => {
  const context = {
    data: { session: { root: () => "ses_root", family: () => ["ses_root", "ses_child", "ses_child", ""] } },
  } as unknown as Context;
  const sessions = probeSessions(context, "ses_root");
  expect(sessions).toEqual(["ses_root", "ses_child"]);
  expect(await probeAnySession(sessions, "PANEL-1")).toEqual({ at: expect.any(Number), unsupported: false });
  expect(await probeAnySession(sessions, "PANEL-2")).toEqual({ at: null, unsupported: false });
});
test("missing family APIs retain the open session", () => {
  const context = { data: { session: {} } } as unknown as Context;
  expect(probeSessions(context, "ses_open")).toEqual(["ses_open"]);
});
test("probes reject malformed data and activity attributed to another session", async () => {
  for (const payload of ["null", "{}", "not json", '[{"actor_session_id":"ses_other"}]']) {
    writeFileSync(executable, `#!/bin/sh\nprintf '%s' ${quote(payload)}\n`);
    expect(await probeSessionTask("ses_root", "PANEL-1")).toEqual({ at: null, unsupported: false });
  }
});
test("a refused session filter is distinguished from ordinary read failures", async () => {
  writeFileSync(executable, '#!/bin/sh\nprintf \'%s\' \'{"error":{"code":"invalid_input"}}\' >&2\nexit 2\n');
  expect(await probeSessionTask("ses_root", "PANEL-1")).toEqual({ at: null, unsupported: true });
  writeFileSync(executable, '#!/bin/sh\nprintf \'%s\' \'{"error":{"code":"not_found"}}\' >&2\nexit 1\n');
  expect(await probeSessionTask("ses_root", "PANEL-1")).toEqual({ at: null, unsupported: false });
});
test("the probe pool limits in-flight reads and stops a superseded cycle", async () => {
  const started: number[] = [];
  const releases: Array<() => void> = [];
  let stopped = false;
  const work = runPool([1, 2, 3, 4], 2, async (item) => {
    started.push(item);
    await new Promise<void>((resolve) => releases.push(resolve));
  }, () => stopped);
  expect(started).toEqual([1, 2]);
  stopped = true;
  for (const release of releases) {
    release();
  }
  await work;
  expect(started).toEqual([1, 2]);
});
test("the probe pool refills its lanes until every task has been read", async () => {
  const completed: number[] = [];
  let active = 0;
  let peak = 0;
  await runPool([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    completed.push(item);
    active -= 1;
  });
  expect(completed.sort()).toEqual([1, 2, 3, 4, 5]);
  expect(peak).toBe(2);
});
function runningContext(input: {
  busy?: boolean;
  tabs?: boolean;
  status?: string;
  permissions?: number;
  forms?: number;
}) {
  return {
    ui: { tabs: { enabled: () => input.tabs ?? true, list: () => input.busy === undefined ? [] : [{ sessionID: "ses_root", busy: input.busy }] } },
    data: { session: {
        status: () => input.status ?? "idle",
        permission: { list: () => Array(input.permissions ?? 0) },
        form: { list: () => Array(input.forms ?? 0) },
      } },
  } as unknown as Context;
}
test("animation follows the host tab independently from task attribution", () => {
  expect(sessionRunning(runningContext({ busy: true }), "ses_root")).toBe(true);
  expect(sessionRunning(runningContext({ busy: false, status: "running" }), "ses_root")).toBe(false);
  expect(sessionRunning(runningContext({ tabs: false, status: "running" }), "ses_root")).toBe(true);
  expect(sessionRunning(runningContext({ tabs: false, status: "running", permissions: 1 }), "ses_root")).toBe(false);
  expect(sessionRunning(runningContext({ tabs: false, status: "running", forms: 1 }), "ses_root")).toBe(false);
});

test("native OpenCode thread activity marks root and child tasks without an identity plugin", async () => {
  const create = (id: string, title: string, overrides: Record<string, string> = {}) => {
    const result = Bun.spawnSync([process.execPath, cli, "task", "create", "PANEL", "--title", title, "--json"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: store, OPENCODE: "1", OPENCODE_SESSION_ID: id, ...overrides },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString()).key as string;
  };
  const root = create("ses_native_root", "Native root activity");
  const child = create("ses_native_child", "Native child activity");
  const override = create("ses_native_other", "Explicit identity wins", { ZINN_SESSION_ID: "ses_explicit_root", ZINN_THREAD_ID: "ses_explicit_child" });
  const family = ["ses_native_root", "ses_native_child"];
  expect(await probeAnySession(family, root)).toEqual({ at: expect.any(Number), unsupported: false });
  expect(await probeAnySession(family, child)).toEqual({ at: expect.any(Number), unsupported: false });
  expect(await probeAnySession(family, "PANEL-2")).toEqual({ at: null, unsupported: false });
  expect((await probeSessionTask("ses_native_other", override)).at).toBeNull();
  expect((await probeSessionTask("ses_explicit_root", override)).at).toBeNumber();
  expect((await probeSessionTask("ses_explicit_child", override)).at).toBeNumber();
});

test("probes use separate bounded session and thread filters", async () => {
  const recorded = join(directory, "probe-args.jsonl");
  writeFileSync(executable, `#!${process.execPath}
import {appendFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(recorded)}, JSON.stringify(args)+"\\n");
console.log(JSON.stringify(args.includes("--thread") ? [{actor_thread_id:"ses_native",actor_session_id:"ses_different",created_at:Date.now()}] : []));
`);
  expect(await probeSessionTask("ses_native", "PANEL-1")).toEqual({ at: expect.any(Number), unsupported: false });
  const calls = (await Bun.file(recorded).text()).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  expect(calls).toHaveLength(2);
  for (const [index, args] of calls.entries()) {
    const flag = index === 0 ? "--session" : "--thread";
    const otherFlag = index === 0 ? "--thread" : "--session";
    expect(args.slice(0, 2)).toEqual(["activity", "list"]);
    expect(args[args.indexOf("--task") + 1]).toBe("PANEL-1");
    expect(args[args.indexOf(flag) + 1]).toBe("ses_native");
    expect(args[args.indexOf("--limit") + 1]).toBe("1");
    expect(args).toContain("--json");
    expect(args).not.toContain(otherFlag);
  }
});

test("the probe returns the newest activity time for the task", async () => {
  const record = (createdAt: number) =>
    `#!/bin/sh\nprintf '%s' ${quote(JSON.stringify([{ actor_session_id: "ses_root", created_at: createdAt }]))}\n`;
  const recent = Date.now() - 5 * 60_000;
  const stale = Date.now() - 15 * 60_000;
  writeFileSync(executable, record(recent));
  expect(await probeSessionTask("ses_root", "PANEL-1")).toEqual({ at: recent, unsupported: false });
  writeFileSync(executable, record(stale));
  expect(await probeSessionTask("ses_root", "PANEL-1")).toEqual({ at: stale, unsupported: false });
  expect(isRecentActivity(recent)).toBe(true);
  expect(isRecentActivity(stale)).toBe(false);
});

test("the newer of the session and thread reads supplies the activity time", async () => {
  const stale = Date.now() - 15 * 60_000;
  const recent = Date.now() - 5 * 60_000;
  writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
const rows = args.includes("--thread")
  ? [{ actor_thread_id: "ses_root", created_at: ${recent} }]
  : [{ actor_session_id: "ses_root", created_at: ${stale} }];
console.log(JSON.stringify(rows));
`);
  expect(await probeSessionTask("ses_root", "PANEL-1")).toEqual({ at: recent, unsupported: false });
});

test("the family's newest activity time wins across sessions", async () => {
  const older = Date.now() - 20 * 60_000;
  const newer = Date.now() - 4 * 60_000;
  writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
const flag = args.includes("--session") ? "--session" : "--thread";
const field = flag === "--session" ? "actor_session_id" : "actor_thread_id";
const sid = args[args.indexOf(flag) + 1];
const at = sid === "ses_older" ? ${older} : ${newer};
console.log(JSON.stringify([{ [field]: sid, created_at: at }]));
`);
  expect(await probeAnySession(["ses_older", "ses_newer"], "PANEL-1")).toEqual({ at: newer, unsupported: false });
});

test("the mark window includes activity exactly at the threshold", () => {
  const now = 1_800_000_000_000;
  expect(isRecentActivity(now, now)).toBe(true);
  expect(isRecentActivity(now - ACTIVITY_MARK_TTL_MS, now)).toBe(true);
  expect(isRecentActivity(now - ACTIVITY_MARK_TTL_MS - 1, now)).toBe(false);
  expect(isRecentActivity(null, now)).toBe(false);
});

test("the probe gate needs a forced read, a zinn command or the recheck window", () => {
  const quiet = { force: false, zinnCommands: 2, lastProbeZinn: 2, msSinceProbe: 0 };
  expect(shouldProbe({ ...quiet, force: true })).toBe(true);
  expect(shouldProbe({ ...quiet, zinnCommands: 3 })).toBe(true);
  expect(shouldProbe({ ...quiet, msSinceProbe: PROBE_RECHECK_MS })).toBe(true);
  expect(shouldProbe({ ...quiet, msSinceProbe: PROBE_RECHECK_MS - 1 })).toBe(false);
  expect(shouldProbe(quiet)).toBe(false);
});
