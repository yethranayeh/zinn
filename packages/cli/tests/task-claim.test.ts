import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CLAIM_WORK_LIMIT_MS } from "@zinn-dev/core";
import { errorDocumentSchema } from "../src/errors";
import { resultSchemas } from "../src/result-schemas";
import { latestVersion, MIGRATIONS } from "../../core/src/migrations/registry";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SESSION_A = { AI_AGENT: "worker", ZINN_SESSION_ID: "session-a" };
const SESSION_B = { AI_AGENT: "worker", ZINN_SESSION_ID: "session-b" };

type ClaimRow = {
  task_id: string;
  actor_kind: string;
  actor_name: string | null;
  actor_session_id: string | null;
  actor_thread_id: string | null;
  claimed_at: number;
  renewed_at: number;
  worked_at: number;
  lease_ms: number;
};

type ClaimEvent = { action: string; actor_session_id: string | null; changes: Record<string, unknown> };

/** A store with project APP and tasks APP-1 and APP-2. */
async function withClaimStore(check: (dir: string) => Promise<void>) {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "APP"], dir);
    await runZinn(["task", "create", "APP", "--title", "Refine the numbers"], dir);
    await runZinn(["task", "create", "APP", "--title", "Second"], dir);
    await check(dir);
  });
}

function claimRows(dir: string) {
  return withTestDb(dir, (db) => db.query<ClaimRow, []>("SELECT * FROM task_claim").all());
}

function claimEvents(dir: string) {
  return withTestDb(dir, (db) =>
    db
      .query<{ action: string; actor_session_id: string | null; changes: string }, []>(
        "SELECT action, actor_session_id, changes FROM activity WHERE action LIKE 'claim%' ORDER BY id",
      )
      .all()
      .map((event): ClaimEvent => ({ ...event, changes: JSON.parse(event.changes) })),
  );
}

/** Moves the claim's times into the past, as if it had been taken that long ago. */
function backdateClaim(dir: string, milliseconds: number) {
  withTestDb(dir, (db) =>
    db.run(
      "UPDATE task_claim SET claimed_at = claimed_at - ?1, renewed_at = renewed_at - ?1, worked_at = worked_at - ?1",
      [milliseconds],
    ),
  );
}

function writes(dir: string) {
  return { claims: claimRows(dir), events: claimEvents(dir) };
}

function parseFailure(stderr: string) {
  return errorDocumentSchema.parse(JSON.parse(stderr)).error;
}

/** The text form of a time in the tests' UTC zone, with seconds. */
function utcTime(milliseconds: number) {
  return new Date(milliseconds).toISOString().replace("T", " ").replace(".000Z", "Z").replace("Z", " +00:00");
}

function humanEnv(dir: string, name: string) {
  const identityFile = join(dir, `${name}.gitconfig`);
  writeFileSync(identityFile, `[user]\n\tname = ${name}\n`);
  return { GIT_CONFIG_GLOBAL: identityFile };
}

test("ZINN-585: task claim on an unclaimed task prints the claim, writes a claim row and records the claim", async () => {
  await withClaimStore(async (dir) => {
    const before = Date.now();
    const claimed = await runZinn(["task", "claim", "APP-1", "--lease", "30m", "--json"], dir, SESSION_A);

    expect(claimed.code).toBe(0);
    expect(claimed.stderr).toBe("");
    const result = resultSchemas.TaskChange.parse(JSON.parse(claimed.stdout));
    expect(result).toMatchObject({
      key: "APP-1",
      changed: true,
      claim: {
        state: "live",
        actor_kind: "agent",
        actor_name: "worker",
        actor_session_id: "session-a",
        actor_thread_id: null,
        lease_ms: 30 * MINUTE_MS,
      },
    });
    expect(result.claim!.claimed_at).toBeGreaterThanOrEqual(before);
    expect(result.claim!.expires_at).toBe(result.claim!.renewed_at + 30 * MINUTE_MS);
    expect(claimRows(dir)).toEqual([
      expect.objectContaining({ actor_session_id: "session-a", lease_ms: 30 * MINUTE_MS }),
    ]);
    expect(claimEvents(dir)).toEqual([
      { action: "claim", actor_session_id: "session-a", changes: { lease_ms: 30 * MINUTE_MS, replaced: null } },
    ]);

    const text = await runZinn(["task", "claim", "APP-2", "--lease", "2h"], dir, SESSION_A);
    expect(text.code).toBe(0);
    const expiresAt = claimRows(dir).find((row) => row.lease_ms === 2 * HOUR_MS)!;
    expect(text.stdout).toStartWith("APP-2 ");
    expect(text.stdout).toContain("worker");
    expect(text.stdout).toContain(utcTime(expiresAt.renewed_at + expiresAt.lease_ms));
  });
});

test("ZINN-585: the holder's repeated claim renews with the new lease, live or expired, without a second claim row", async () => {
  await withClaimStore(async (dir) => {
    await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_A);

    const renewed = await runZinn(["task", "claim", "APP-1", "--lease", "1h", "--json"], dir, SESSION_A);
    expect(renewed.code).toBe(0);
    expect(JSON.parse(renewed.stdout).claim).toMatchObject({ state: "live", lease_ms: HOUR_MS });

    backdateClaim(dir, 2 * HOUR_MS);
    expect(JSON.parse((await runZinn(["task", "view", "APP-1", "--json"], dir)).stdout).claim.state).toBe("expired");

    const revived = await runZinn(["task", "claim", "APP-1", "--lease", "45m", "--json"], dir, SESSION_A);
    expect(revived.code).toBe(0);
    expect(JSON.parse(revived.stdout).claim).toMatchObject({ state: "live", lease_ms: 45 * MINUTE_MS });
    expect(claimRows(dir)).toHaveLength(1);
    expect(claimEvents(dir).map((event) => event.action)).toEqual(["claim", "claim_heartbeat", "claim_heartbeat"]);
    expect(claimEvents(dir)[2]!.changes).toMatchObject({ lease_ms: 45 * MINUTE_MS, previous_expires_at: expect.any(Number) });
  });
});

test("ZINN-585: a second session replaces an expired claim and records the claim it replaced", async () => {
  await withClaimStore(async (dir) => {
    await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_A);
    backdateClaim(dir, HOUR_MS);

    const replaced = await runZinn(["task", "claim", "APP-1", "--lease", "30m", "--json"], dir, SESSION_B);
    expect(replaced.code).toBe(0);
    expect(JSON.parse(replaced.stdout).claim).toMatchObject({ state: "live", actor_session_id: "session-b" });
    expect(claimRows(dir)).toEqual([expect.objectContaining({ actor_session_id: "session-b" })]);
    expect(claimEvents(dir).at(-1)).toMatchObject({
      action: "claim",
      actor_session_id: "session-b",
      changes: { replaced: { actor_kind: "agent", actor_name: "worker", actor_session_id: "session-a", actor_thread_id: null } },
    });
  });
});

test("ZINN-585: a second session is refused a live claim with the expiry in details, and --force takes it over", async () => {
  await withClaimStore(async (dir) => {
    await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_A);
    const expiresAt = JSON.parse((await runZinn(["task", "view", "APP-1", "--json"], dir)).stdout).claim.expires_at;
    const before = writes(dir);

    const refused = await runZinn(["task", "claim", "APP-1", "--lease", "30m", "--json"], dir, SESSION_B);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    const failure = parseFailure(refused.stderr);
    expect(failure).toMatchObject({
      code: "conflict",
      details: { entity: "task", key: "APP-1", reason: "claimed", claimExpiresAt: expiresAt },
    });
    expect(failure.message).toContain("session-a");
    expect(failure.message).not.toContain("--force");
    expect(writes(dir)).toEqual(before);

    const textRefusal = await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_B);
    expect(textRefusal.code).toBe(1);
    expect(textRefusal.stdout).toBe("");
    expect(textRefusal.stderr).toContain("session-a");
    expect(textRefusal.stderr).toContain(utcTime(expiresAt));

    const forced = await runZinn(["task", "claim", "APP-1", "--lease", "30m", "--force", "--json"], dir, SESSION_B);
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.stdout).claim).toMatchObject({ actor_session_id: "session-b" });
    expect(claimEvents(dir).at(-1)).toMatchObject({
      action: "claim_take",
      actor_session_id: "session-b",
      changes: { replaced: { actor_session_id: "session-a" } },
    });
  });
});

test("ZINN-585: a person without a session holds a claim by name, and another person is refused", async () => {
  await withClaimStore(async (dir) => {
    const alice = humanEnv(dir, "Alice");
    const bob = humanEnv(dir, "Bob");

    const claimed = await runZinn(["task", "claim", "APP-1", "--lease", "1h", "--json"], dir, alice);
    expect(claimed.code).toBe(0);
    expect(JSON.parse(claimed.stdout).claim).toMatchObject({
      actor_kind: "human", actor_name: "Alice", actor_session_id: null, actor_thread_id: null,
    });

    const refused = await runZinn(["task", "heartbeat", "APP-1", "--json"], dir, bob);
    expect(refused.code).toBe(1);
    expect(parseFailure(refused.stderr)).toMatchObject({ code: "conflict", details: { reason: "claimed" } });

    expect((await runZinn(["task", "heartbeat", "APP-1"], dir, alice)).code).toBe(0);
    expect((await runZinn(["task", "release", "APP-1"], dir, alice)).code).toBe(0);
    expect(claimRows(dir)).toEqual([]);
  });
});

test("ZINN-585: an agent without a session or thread cannot claim, and the failure names ZINN_SESSION_ID", async () => {
  await withClaimStore(async (dir) => {
    const refused = await runZinn(["task", "claim", "APP-1", "--lease", "30m", "--json"], dir, { AI_AGENT: "worker" });

    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    const failure = parseFailure(refused.stderr);
    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toContain("ZINN_SESSION_ID");
    expect(writes(dir)).toEqual({ claims: [], events: [] });
  });
});

test("ZINN-585: an archived task cannot be claimed, and archiving releases a claim", async () => {
  await withClaimStore(async (dir) => {
    await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_A);
    expect((await runZinn(["task", "archive", "APP-1"], dir, SESSION_A)).code).toBe(0);
    expect(claimRows(dir)).toEqual([]);
    expect(claimEvents(dir).at(-1)).toMatchObject({ action: "claim_release", changes: { cause: "archive" } });
    const before = writes(dir);

    const refused = await runZinn(["task", "claim", "APP-1", "--lease", "30m", "--json"], dir, SESSION_A);
    expect(refused.code).toBe(1);
    expect(parseFailure(refused.stderr)).toMatchObject({ code: "conflict", details: { key: "APP-1", reason: "archived" } });
    expect(writes(dir)).toEqual(before);
  });
});

test("ZINN-585: task heartbeat renews the holder's claim with its lease and refuses without a claim or for another holder", async () => {
  await withClaimStore(async (dir) => {
    const unclaimed = await runZinn(["task", "heartbeat", "APP-1", "--json"], dir, SESSION_A);
    expect(unclaimed.code).toBe(1);
    expect(unclaimed.stdout).toBe("");
    expect(parseFailure(unclaimed.stderr)).toMatchObject({ code: "conflict", details: { key: "APP-1", reason: "not_claimed" } });
    expect(writes(dir)).toEqual({ claims: [], events: [] });

    await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_A);
    backdateClaim(dir, 10 * MINUTE_MS);
    const previous = claimRows(dir)[0]!;

    const renewed = await runZinn(["task", "heartbeat", "APP-1", "--json"], dir, SESSION_A);
    expect(renewed.code).toBe(0);
    const claim = JSON.parse(renewed.stdout).claim;
    expect(claim).toMatchObject({ state: "live", lease_ms: 30 * MINUTE_MS, worked_at: previous.worked_at });
    expect(claim.renewed_at).toBeGreaterThan(previous.renewed_at);
    expect(claimEvents(dir).at(-1)).toEqual({
      action: "claim_heartbeat",
      actor_session_id: "session-a",
      changes: { lease_ms: 30 * MINUTE_MS, previous_expires_at: previous.renewed_at + previous.lease_ms },
    });

    const before = writes(dir);
    const other = await runZinn(["task", "heartbeat", "APP-1", "--json"], dir, SESSION_B);
    expect(other.code).toBe(1);
    expect(parseFailure(other.stderr)).toMatchObject({ code: "conflict", details: { reason: "claimed", claimExpiresAt: claim.expires_at } });
    expect(writes(dir)).toEqual(before);
  });
});

test("ZINN-585: task release deletes the holder's claim, does nothing without one and refuses another holder", async () => {
  await withClaimStore(async (dir) => {
    await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_A);
    const before = writes(dir);

    const other = await runZinn(["task", "release", "APP-1", "--json"], dir, SESSION_B);
    expect(other.code).toBe(1);
    expect(other.stdout).toBe("");
    expect(parseFailure(other.stderr)).toMatchObject({ code: "conflict", details: { reason: "claimed" } });
    expect(writes(dir)).toEqual(before);

    const released = await runZinn(["task", "release", "APP-1", "--json"], dir, SESSION_A);
    expect(released.code).toBe(0);
    expect(released.stderr).toBe("");
    expect(JSON.parse(released.stdout)).toMatchObject({ key: "APP-1", changed: true, claim: null });
    expect(claimRows(dir)).toEqual([]);
    expect(claimEvents(dir).at(-1)).toEqual({
      action: "claim_release",
      actor_session_id: "session-a",
      changes: {
        actor_kind: "agent", actor_name: "worker", actor_session_id: "session-a", actor_thread_id: null,
        claimed_at: before.claims[0]!.claimed_at, expires_at: expect.any(Number), cause: "release",
      },
    });

    const afterRelease = writes(dir);
    const again = await runZinn(["task", "release", "APP-1", "--json"], dir, SESSION_A);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ key: "APP-1", changed: false, claim: null });
    expect(again.stderr).toContain("APP-1");
    expect(writes(dir)).toEqual(afterRelease);
  });
});

test("ZINN-585: a day without work refuses heartbeat and a repeated claim with claim_limit", async () => {
  await withClaimStore(async (dir) => {
    await runZinn(["task", "claim", "APP-1", "--lease", "24h"], dir, SESSION_A);
    backdateClaim(dir, CLAIM_WORK_LIMIT_MS);
    const before = writes(dir);

    for (const args of [["task", "heartbeat", "APP-1"], ["task", "claim", "APP-1", "--lease", "1h"]]) {
      const refused = await runZinn([...args, "--json"], dir, SESSION_A);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(parseFailure(refused.stderr)).toMatchObject({
        code: "conflict",
        details: { key: "APP-1", reason: "claim_limit", claimExpiresAt: expect.any(Number) },
      });
      expect(writes(dir)).toEqual(before);
    }
  });
});

test("ZINN-585: --lease takes whole minutes or hours from 1m through 24h and is required", async () => {
  await withClaimStore(async (dir) => {
    for (const [lease, leaseMs] of [["1m", MINUTE_MS], ["90m", 90 * MINUTE_MS], ["24h", 24 * HOUR_MS]] as const) {
      const claimed = await runZinn(["task", "claim", "APP-1", "--lease", lease, "--json"], dir, SESSION_A);
      expect(claimed.code).toBe(0);
      expect(JSON.parse(claimed.stdout).claim.lease_ms).toBe(leaseMs);
    }
    await runZinn(["task", "release", "APP-1"], dir, SESSION_A);

    for (const lease of ["30", "30s", "1.5h", "-30m", "30 m", "2H", "1h30m"]) {
      const refused = await runZinn(["task", "claim", "APP-1", `--lease=${lease}`, "--json"], dir, SESSION_A);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(parseFailure(refused.stderr)).toMatchObject({ code: "invalid_input", details: { argument: "--lease" } });
    }

    for (const lease of ["0m", "25h", "1441m"]) {
      const refused = await runZinn(["task", "claim", "APP-1", "--lease", lease, "--json"], dir, SESSION_A);
      expect(refused.code).toBe(1);
      expect(parseFailure(refused.stderr)).toMatchObject({ code: "invalid_input", details: { argument: "--lease" } });
    }

    const missing = await runZinn(["task", "claim", "APP-1", "--json"], dir, SESSION_A);
    expect(missing.code).toBe(1);
    expect(parseFailure(missing.stderr)).toMatchObject({ code: "invalid_input", details: { argument: "--lease" } });
    expect(writes(dir).claims).toEqual([]);
  });
});

test("ZINN-585: every Task JSON carries the claim, matching the result schemas", async () => {
  await withClaimStore(async (dir) => {
    await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_A);
    const json = async (...args: Array<string>) => JSON.parse((await runZinn([...args, "--json"], dir)).stdout);
    const claim = (await json("task", "view", "APP-1")).claim;
    expect(claim).toMatchObject({ state: "live", actor_session_id: "session-a" });

    const list = resultSchemas.TaskList.parse(await json("task", "list", "APP"));
    expect(list.map((entry) => entry.claim)).toEqual([claim, null]);
    const search = resultSchemas.TaskList.parse(await json("task", "search", "refine", "APP"));
    expect(search.map((entry) => entry.claim)).toEqual([claim]);
    // task next skips the claimed APP-1.
    expect(resultSchemas.NextTask.parse(await json("task", "next", "APP"))).toMatchObject({ key: "APP-2", claim: null });
    expect(resultSchemas.TaskDetail.parse(await json("task", "view", "APP-1")).claim).toEqual(claim);
    expect(resultSchemas.TaskDetail.parse(await json("task", "view", "APP-2")).claim).toBeNull();

    // An edit by someone else leaves the claim as it was.
    const edited = resultSchemas.TaskChange.parse(await json("task", "edit", "APP-1", "--priority", "high"));
    expect(edited.claim).toEqual(claim);
  });
});

test("ZINN-585: capabilities list the claim commands and give Task a nullable claim", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const capabilities = JSON.parse((await runZinn(["capabilities", "--json"], dir)).stdout);
    const commands = new Map(capabilities.commands.map((command: { path: Array<string> }) => [command.path.join(" "), command]));

    for (const command of ["task claim", "task heartbeat", "task release"]) {
      expect(commands.get(command)).toMatchObject({
        effects: { domain: "update" },
        results: [{ schemaRef: "#/schemas/definitions/TaskChange" }],
      });
    }
    expect(commands.get("task claim")).toMatchObject({
      input: { options: { lease: { type: "string", required: true }, force: { type: "boolean" } } },
    });
    const task = capabilities.schemas.definitions.Task;
    expect(task.required).toContain("claim");
    expect(task.properties.claim.anyOf).toContainEqual(expect.objectContaining({ type: "null" }));
    expect(capabilities.schemas.definitions.ErrorEnvelope.properties.error.properties.details.properties).toHaveProperty("claimExpiresAt");
  });
});

test("ZINN-585: task view shows a live and an expired claim with its holder and lease end, and list rows only a live holder", async () => {
  await withClaimStore(async (dir) => {
    await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_A);
    const live = claimRows(dir)[0]!;

    const liveView = await runZinn(["task", "view", "APP-1"], dir);
    expect(liveView.code).toBe(0);
    expect(liveView.stdout).toContain("worker");
    expect(liveView.stdout).toContain(utcTime(live.renewed_at + live.lease_ms));

    const liveList = (await runZinn(["task", "list", "APP"], dir)).stdout.split("\n");
    expect(liveList[0]).toStartWith("APP-1 ");
    expect(liveList[0]).toContain("worker");
    expect(liveList[1]).not.toContain("worker");

    backdateClaim(dir, HOUR_MS);
    const expiredView = await runZinn(["task", "view", "APP-1"], dir);
    expect(expiredView.stdout).toContain("worker");
    expect(expiredView.stdout).toContain(utcTime(live.renewed_at - HOUR_MS + live.lease_ms));
    // The rows differ in more than the time, since one claim is live and the other expired.
    const liveRow = liveView.stdout.split("\n")[0]!.replace(utcTime(live.renewed_at + live.lease_ms), "");
    const expiredRow = expiredView.stdout.split("\n")[0]!.replace(utcTime(live.renewed_at - HOUR_MS + live.lease_ms), "");
    expect(expiredRow).not.toBe(liveRow);

    const expiredList = await runZinn(["task", "list", "APP"], dir);
    expect(expiredList.stdout).not.toContain("worker");
    expect(expiredList.stdout).toContain("Refine the numbers");
  });
});

test("ZINN-585: activity output names the claim holder, the replaced holder, the previous expiry and the release cause", async () => {
  await withClaimStore(async (dir) => {
    await runZinn(["task", "claim", "APP-1", "--lease", "30m"], dir, SESSION_A);
    const first = claimRows(dir)[0]!;
    await runZinn(["task", "heartbeat", "APP-1"], dir, SESSION_A);
    await runZinn(["task", "claim", "APP-1", "--lease", "1h", "--force"], dir, { AI_AGENT: "taker", ZINN_SESSION_ID: "session-b" });
    await runZinn(["task", "release", "APP-1"], dir, { AI_AGENT: "taker", ZINN_SESSION_ID: "session-b" });

    const history = await runZinn(["activity", "list", "--task", "APP-1"], dir);
    expect(history.code).toBe(0);
    const lines = history.stdout.split("\n").filter((line) => line.includes("APP-1"));
    const [release, take, heartbeat, claim] = lines;
    expect(release).toContain("taker (agent)");
    expect(release).toContain("cause: release");
    expect(release).not.toContain("actor_session_id");
    expect(take).toContain("replaced: worker (agent)");
    expect(heartbeat).toContain(`previous_expires_at: ${utcTime(first.renewed_at + first.lease_ms)}`);
    expect(claim).toContain(String(30 * MINUTE_MS));

    const releaseId = release!.split(" ")[0]!;
    const detail = await runZinn(["activity", "view", releaseId], dir);
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain("session-b");
    expect(detail.stdout).toContain(utcTime(first.claimed_at).slice(0, 10));
  });
});

test("ZINN-585: a database from before claims, opened read-only, reads with claim null and refuses a claim", async () => {
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
    const previousVersion = latestVersion(MIGRATIONS) - 1;
    withTestDb(store, (db) => {
      db.run("DROP TABLE task_claim");
      db.run(`PRAGMA user_version = ${previousVersion}`);
    });
    const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: join(dir, "home"), ...SESSION_A };
    delete env.ZINN_DIR;
    const run = (args: Array<string>) => runProcessAsync([process.execPath, CLI_PATH, ...args], { cwd: repository, env });

    const list = await run(["task", "list", "APP", "--json"]);
    expect(list.code).toBe(0);
    expect(resultSchemas.TaskList.parse(JSON.parse(list.stdout)).map((entry) => entry.claim)).toEqual([null]);

    const view = await run(["task", "view", "APP-1", "--json"]);
    expect(view.code).toBe(0);
    expect(JSON.parse(view.stdout).claim).toBeNull();

    const refused = await run(["task", "claim", "APP-1", "--lease", "30m", "--json"]);
    expect(refused.code).toBe(1);
    expect(parseFailure(refused.stderr)).toMatchObject({ code: "conflict", details: { reason: "older_database" } });
    expect(withTestDb(store, (db) => db.query("PRAGMA user_version").get())).toEqual({ user_version: previousVersion });
  });
});

test("ZINN-585: task help lists the claim commands and each prints its usage", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const help = await runZinn(["task", "--help"], dir);
    expect(help.code).toBe(0);
    for (const command of ["claim", "heartbeat", "release"]) {
      expect(help.stdout).toContain(command);
      const commandHelp = await runZinn(["task", command, "--help"], dir);
      expect(commandHelp.code).toBe(0);
      expect(commandHelp.stdout).toStartWith(`Usage: zinn task ${command} <task-key>`);
    }
    expect((await runZinn(["task", "claim", "--help"], dir)).stdout).toContain("--lease <duration>");
  });
});
