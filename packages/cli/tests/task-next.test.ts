import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIM_WORK_LIMIT_MS } from "@zinn-dev/core";
import { errorDocumentSchema } from "../src/errors";
import { resultSchemas } from "../src/result-schemas";
import { TASK_CLAIM_VERSION } from "../../core/src/migrations/task-claim";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

const MINUTE_MS = 60_000;
const SESSION_A = { AI_AGENT: "worker", ZINN_SESSION_ID: "session-a" };
const SESSION_B = { AI_AGENT: "worker", ZINN_SESSION_ID: "session-b" };

/** Moves the given claim times of every claim into the past by `milliseconds`. */
function backdateClaims(dir: string, fields: Array<"renewed_at" | "worked_at">, milliseconds: number) {
  const assignments = fields.map((field) => `${field} = ${field} - ?1`).join(", ");
  withTestDb(dir, (db) => db.run(`UPDATE task_claim SET ${assignments}`, [milliseconds]));
}

/** The key `task next` returns for the given arguments, or null. */
async function nextKey(dir: string, args: Array<string>, env: Record<string, string> = {}) {
  const result = await runZinn(["--json", "task", "next", ...args], dir, env);
  expect(result.code).toBe(0);
  return (JSON.parse(result.stdout) as { key: string } | null)?.key ?? null;
}

async function claim(dir: string, taskKey: string, env: Record<string, string>) {
  const claimed = await runZinn(["task", "claim", taskKey, "--lease", "30m", "--json"], dir, env);
  expect(claimed.code).toBe(0);
}

test("task next reports an empty answer with exit 0 and JSON null", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "APP"], testDir);

    const text = await runZinn(["task", "next", "APP"], testDir);
    const json = await runZinn(["--json", "task", "next", "APP"], testDir);

    expect(text.code).toBe(0);
    expect(text.stdout.trim().split("\n")).toHaveLength(1);
    expect(text.stdout).not.toContain("APP-");
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toBeNull();
  });
});

test("task next prints the ready task as a task row and JSON task", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "APP"], testDir);
    await runZinn(["task", "create", "APP", "--title", "Blocked", "--priority", "urgent"], testDir);
    await runZinn(["task", "create", "APP", "--title", "Ready", "--column", "TODO"], testDir);
    await runZinn(["task", "relation", "create", "APP-1", "APP-2", "--type", "dependency"], testDir);

    const text = await runZinn(["task", "next", "APP"], testDir);
    const json = await runZinn(["--json", "task", "next", "APP", "--column", "todo"], testDir);

    expect(text.code).toBe(0);
    expect(text.stdout).toContain("APP-2");
    expect(text.stdout).toContain("Ready");
    expect(json.code).toBe(0);
    expect(resultSchemas.NextTask.parse(JSON.parse(json.stdout))).toMatchObject({
      key: "APP-2",
      title: "Ready",
    });
  });
});

test("task next uses defaultProject unless --all-projects is given", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "APP"], testDir);
    await runZinn(["project", "create", "OTHER"], testDir);
    await runZinn(["task", "create", "APP", "--title", "App task", "--priority", "low"], testDir);
    await runZinn(["task", "create", "OTHER", "--title", "Other task", "--priority", "high"], testDir);
    await Bun.write(join(testDir, "settings.json"), JSON.stringify({ defaultProject: "APP" }));

    const nextKey = async (args: Array<string>) => {
      const result = await runZinn(["--json", "task", "next", ...args], testDir);
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout).key;
    };

    expect(await nextKey([])).toBe("APP-1");
    expect(await nextKey(["OTHER"])).toBe("OTHER-1");
    expect(await nextKey(["--all-projects"])).toBe("OTHER-1");

    const combined = await runZinn(["--json", "task", "next", "APP", "--all-projects"], testDir);
    expect(combined.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(combined.stderr)).error.code).toBe("invalid_input");
  });
});

test("task next fails for an unknown project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "APP"], testDir);

    const result = await runZinn(["--json", "task", "next", "NOPE"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({
      code: "not_found",
      details: { entity: "project", key: "NOPE" },
    });
  });
});

test("ZINN-586: task next skips a task with a live claim and returns it once the lease ran out", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "APP"], dir);
    await runZinn(["task", "create", "APP", "--title", "Claimed", "--priority", "urgent"], dir);
    await runZinn(["task", "create", "APP", "--title", "Following", "--priority", "low"], dir);
    await claim(dir, "APP-1", SESSION_A);

    expect(await nextKey(dir, ["APP"], SESSION_B)).toBe("APP-2");
    expect(await nextKey(dir, ["APP", "--column", "Backlog"], SESSION_B)).toBe("APP-2");

    await runZinn(["task", "archive", "APP-2"], dir);
    expect(await nextKey(dir, ["APP"], SESSION_B)).toBeNull();
    expect(await nextKey(dir, ["APP", "--column", "Backlog"], SESSION_B)).toBeNull();

    backdateClaims(dir, ["renewed_at"], 30 * MINUTE_MS);
    expect(await nextKey(dir, ["APP"], SESSION_B)).toBe("APP-1");
    expect(await nextKey(dir, ["APP", "--column", "Backlog"], SESSION_B)).toBe("APP-1");
  });
});

test("ZINN-586: task next returns a claimed task a day after the holder's last work, though its lease runs", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "APP"], dir);
    await runZinn(["task", "create", "APP", "--title", "Claimed"], dir);
    await claim(dir, "APP-1", SESSION_A);

    backdateClaims(dir, ["worked_at"], CLAIM_WORK_LIMIT_MS - MINUTE_MS);
    expect(await nextKey(dir, ["APP"])).toBeNull();

    backdateClaims(dir, ["worked_at"], MINUTE_MS);
    expect(await nextKey(dir, ["APP"])).toBe("APP-1");
    expect(await nextKey(dir, ["APP", "--column", "Backlog"])).toBe("APP-1");
  });
});

test("ZINN-586: task next on the in-progress column finds work with no live claim, which task claim then takes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "APP"], dir);
    await runZinn(["task", "create", "APP", "--title", "Abandoned", "--column", "Doing"], dir);
    await claim(dir, "APP-1", SESSION_A);
    const inProgress = ["APP", "--column", "Doing"];

    expect(await nextKey(dir, ["APP"], SESSION_B)).toBeNull();
    expect(await nextKey(dir, inProgress, SESSION_B)).toBeNull();

    backdateClaims(dir, ["renewed_at", "worked_at"], 30 * MINUTE_MS);
    expect(await nextKey(dir, ["APP"], SESSION_B)).toBeNull();
    expect(await nextKey(dir, inProgress, SESSION_B)).toBe("APP-1");

    await claim(dir, "APP-1", SESSION_B);
    expect(await nextKey(dir, inProgress, SESSION_B)).toBeNull();
  });
});

test("ZINN-586: task next skips the caller's own live claim", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "APP"], dir);
    await runZinn(["task", "create", "APP", "--title", "Own"], dir);
    await claim(dir, "APP-1", SESSION_A);

    expect(await nextKey(dir, ["APP"], SESSION_A)).toBeNull();
    expect(await nextKey(dir, ["APP", "--column", "Backlog"], SESSION_A)).toBeNull();
  });
});

test("ZINN-586: task next answers on a database from before claims, opened read-only", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const store = join(dir, "store");
    const repository = join(dir, "repository");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(join(dir, "home"));
    mkdirSync(store);
    // A store chosen by a settings file is protected, so a source build opens its older database read-only.
    writeFileSync(join(repository, "zinn.local.json"), JSON.stringify({ storage: { directory: "../store" } }));
    await runZinn(["project", "create", "APP"], store);
    await runZinn(["task", "create", "APP", "--title", "Kept"], store);
    await claim(store, "APP-1", SESSION_A);
    withTestDb(store, (db) => {
      db.run("DROP TABLE task_claim");
      db.run(`PRAGMA user_version = ${TASK_CLAIM_VERSION - 1}`);
    });
    const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: join(dir, "home"), ...SESSION_A };
    delete env.ZINN_DIR;

    const next = await runProcessAsync([process.execPath, CLI_PATH, "task", "next", "APP", "--json"], {
      cwd: repository,
      env,
    });

    expect(next.code).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({ key: "APP-1", claim: null });
  });
});
