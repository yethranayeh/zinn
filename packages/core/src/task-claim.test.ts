import type { Actor, TaskClaimRecord } from "./types";

import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "#sqlite";

import { activityActionSchema, comment, label, project, relation, task } from "../index";
import { getDb, writeTransaction } from "./db";
import * as dbClaim from "./db/claim";
import { CLAIM_WORK_LIMIT_MS, MIN_CLAIM_LEASE_MS } from "./schemas/task";
import { recordTaskActivity } from "./operations/shared";
import { MIGRATIONS } from "./migrations/registry";
import { taskClaimMigration } from "./migrations/task-claim";
import { upgradeSchema } from "./migrations/runner";
import { seedBaseline } from "./migrations/testing";
import { storagePaths } from "./storage";
import { withEnvironment, withTestStore } from "./testing";

const START = Date.UTC(2026, 10, 1);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LEASE_MS = HOUR_MS;
const CONCURRENT_CLAIMS = 8;

const agentA: Actor = { name: "Agent", email: null, kind: "agent", sessionId: "session-a" };
const agentB: Actor = { name: "Agent", email: null, kind: "agent", sessionId: "session-b" };
const alice: Actor = { name: "Alice", email: null, kind: "human" };
const bob: Actor = { name: "Bob", email: null, kind: "human" };

afterEach(() => {
  setSystemTime();
});

function at(time: number) {
  setSystemTime(new Date(time));
  return time;
}

/** A store with project APP and task APP-1, created at START. */
function withClaimStore(check: (taskKey: string, projectId: string) => void) {
  withTestStore(() => {
    at(START);
    const app = project.create({ key: "APP" }, alice);
    const created = task.create({ project_id: app.id, title: "Claimed" }, alice);
    check(created.key, app.id);
  });
}

function claimRows() {
  return getDb().query<TaskClaimRecord, []>("SELECT * FROM task_claim").all();
}

function claimActivity(taskKey: string) {
  return task.activity(taskKey).filter((event) => event.action.startsWith("claim"));
}

function taskRow(taskKey: string) {
  const { claim, ...row } = task.getByKey(taskKey);
  return row;
}

function failureOf(call: () => unknown) {
  try {
    call();
  } catch (error) {
    return error as { kind: string; facts: Record<string, unknown>; message: string };
  }

  throw new Error("Expected the call to fail");
}

/** Asserts that a call fails and writes nothing, and returns the failure. */
function expectRefused(taskKey: string, call: () => unknown) {
  const rows = claimRows();
  const events = task.activity(taskKey);
  const failure = failureOf(call);

  expect(claimRows()).toEqual(rows);
  expect(task.activity(taskKey)).toEqual(events);
  return failure;
}

test("ZINN-585: a claim on an unclaimed task records the holder, the lease and a claim row, and leaves the task row alone", () => {
  withClaimStore((taskKey) => {
    const before = taskRow(taskKey);
    const now = at(START + MINUTE_MS);
    const result = task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);

    expect(result.changed).toBe(true);
    expect(result.task.claim).toEqual({
      state: "live",
      actor_kind: "agent",
      actor_name: "Agent",
      actor_session_id: "session-a",
      actor_thread_id: null,
      claimed_at: now,
      renewed_at: now,
      worked_at: now,
      lease_ms: LEASE_MS,
      expires_at: now + LEASE_MS,
    });
    expect(claimRows()).toHaveLength(1);
    expect(taskRow(taskKey)).toEqual(before);
    expect(claimActivity(taskKey)).toMatchObject([
      { action: "claim", actor_session_id: "session-a", changes: { lease_ms: LEASE_MS, replaced: null } },
    ]);
  });
});

test("ZINN-585: the holder's repeated claim renews with the new lease and keeps claimed_at, also once the lease ran out", () => {
  withClaimStore((taskKey) => {
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    const later = at(START + 2 * LEASE_MS);
    expect(task.getByKey(taskKey).claim?.state).toBe("expired");

    const result = task.claim({ taskKey, leaseMs: 2 * LEASE_MS }, agentA);

    expect(result.task.claim).toMatchObject({
      state: "live", claimed_at: START, renewed_at: later, worked_at: START, lease_ms: 2 * LEASE_MS,
      expires_at: later + 2 * LEASE_MS,
    });
    expect(claimRows()).toHaveLength(1);
    expect(claimActivity(taskKey).at(-1)).toMatchObject({
      action: "claim_heartbeat",
      changes: { lease_ms: 2 * LEASE_MS, previous_expires_at: START + LEASE_MS },
    });
  });
});

test("ZINN-585: a claim replaces another holder's expired claim and records the replaced claim", () => {
  withClaimStore((taskKey) => {
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    const later = at(START + LEASE_MS);

    const result = task.claim({ taskKey, leaseMs: LEASE_MS }, agentB);

    expect(result.task.claim).toMatchObject({ actor_session_id: "session-b", claimed_at: later });
    expect(claimRows()).toHaveLength(1);
    expect(claimActivity(taskKey).at(-1)).toMatchObject({
      action: "claim",
      changes: {
        lease_ms: LEASE_MS,
        replaced: {
          actor_kind: "agent", actor_name: "Agent", actor_session_id: "session-a", actor_thread_id: null,
          claimed_at: START, expires_at: START + LEASE_MS,
        },
      },
    });
  });
});

test("ZINN-585: another holder's live claim refuses a claim unless force takes it over", () => {
  withClaimStore((taskKey) => {
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    at(START + MINUTE_MS);

    const failure = expectRefused(taskKey, () => task.claim({ taskKey, leaseMs: LEASE_MS }, agentB));
    expect(failure).toMatchObject({
      kind: "conflict",
      facts: { entity: "task", key: taskKey, reason: "claimed", claimExpiresAt: START + LEASE_MS },
    });
    expect(failure.message).toContain("session-a");

    const taken = task.claim({ taskKey, leaseMs: LEASE_MS, force: true }, agentB);
    expect(taken.task.claim).toMatchObject({ state: "live", actor_session_id: "session-b" });
    expect(claimRows()).toHaveLength(1);
    expect(claimActivity(taskKey).at(-1)).toMatchObject({
      action: "claim_take",
      actor_session_id: "session-b",
      changes: { lease_ms: LEASE_MS, replaced: { actor_session_id: "session-a", claimed_at: START } },
    });
  });
});

test("ZINN-585: an archived task cannot be claimed", () => {
  withClaimStore((taskKey) => {
    task.archive(taskKey, alice);

    const failure = expectRefused(taskKey, () => task.claim({ taskKey, leaseMs: LEASE_MS }, agentA));
    expect(failure).toMatchObject({ kind: "conflict", facts: { key: taskKey, reason: "archived" } });
  });
});

test("ZINN-585: a heartbeat renews the holder's claim with its stored lease and never creates one", () => {
  withClaimStore((taskKey) => {
    expect(expectRefused(taskKey, () => task.heartbeat(taskKey, agentA))).toMatchObject({
      kind: "conflict", facts: { key: taskKey, reason: "not_claimed" },
    });
    expect(claimRows()).toEqual([]);

    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    const later = at(START + 2 * LEASE_MS);
    const result = task.heartbeat(taskKey, agentA);

    expect(result).toMatchObject({ changed: true });
    expect(result.task.claim).toMatchObject({
      state: "live", renewed_at: later, worked_at: START, lease_ms: LEASE_MS, expires_at: later + LEASE_MS,
    });
    expect(claimActivity(taskKey).at(-1)).toMatchObject({
      action: "claim_heartbeat",
      changes: { lease_ms: LEASE_MS, previous_expires_at: START + LEASE_MS },
    });
  });
});

test("ZINN-585: a heartbeat or release by another holder is refused, whether the claim is live or expired", () => {
  withClaimStore((taskKey) => {
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);

    for (const time of [START + MINUTE_MS, START + 2 * LEASE_MS]) {
      at(time);
      for (const call of [() => task.heartbeat(taskKey, agentB), () => task.release(taskKey, agentB)]) {
        expect(expectRefused(taskKey, call)).toMatchObject({
          kind: "conflict", facts: { key: taskKey, reason: "claimed", claimExpiresAt: START + LEASE_MS },
        });
      }
    }
  });
});

test("ZINN-585: release deletes the holder's claim and records it, and an unclaimed task is left unchanged", () => {
  withClaimStore((taskKey) => {
    const unclaimed = task.release(taskKey, agentA);
    expect(unclaimed).toMatchObject({ changed: false, task: { key: taskKey, claim: null } });
    expect(claimActivity(taskKey)).toEqual([]);

    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    at(START + MINUTE_MS);
    const before = taskRow(taskKey);
    const released = task.release(taskKey, agentA);

    expect(released).toMatchObject({ changed: true, task: { claim: null } });
    expect(claimRows()).toEqual([]);
    expect(taskRow(taskKey)).toEqual(before);
    expect(claimActivity(taskKey).at(-1)).toMatchObject({
      action: "claim_release",
      actor_session_id: "session-a",
      changes: {
        actor_kind: "agent", actor_name: "Agent", actor_session_id: "session-a", actor_thread_id: null,
        claimed_at: START, expires_at: START + LEASE_MS, cause: "release",
      },
    });
  });
});

test("ZINN-585: holders match by session, else thread, else kind and name, and an agent with neither cannot claim", () => {
  withClaimStore((taskKey) => {
    const renamed = { ...agentA, name: "Other name", threadId: "other-thread" };
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    expect(task.heartbeat(taskKey, renamed).changed).toBe(true);
    // A session that returns under a new id is a different holder.
    expect(failureOf(() => task.heartbeat(taskKey, { ...agentA, sessionId: "session-a2" }))).toMatchObject({
      facts: { reason: "claimed" },
    });
    task.release(taskKey, agentA);

    const threadOnly: Actor = { name: null, email: null, kind: "agent", threadId: "thread-1" };
    task.claim({ taskKey, leaseMs: LEASE_MS }, threadOnly);
    expect(task.getByKey(taskKey).claim).toMatchObject({ actor_session_id: null, actor_thread_id: "thread-1" });
    expect(task.heartbeat(taskKey, { ...threadOnly, sessionId: "any-session" }).changed).toBe(true);
    expect(failureOf(() => task.heartbeat(taskKey, { ...threadOnly, threadId: "thread-2" }))).toMatchObject({
      facts: { reason: "claimed" },
    });
    expect(task.release(taskKey, threadOnly).changed).toBe(true);
  });
});

test("ZINN-585: a person holds a claim by name, and an agent without a session or thread is refused", () => {
  withClaimStore((taskKey) => {
    task.claim({ taskKey, leaseMs: LEASE_MS }, alice);
    expect(task.heartbeat(taskKey, alice).changed).toBe(true);
    for (const other of [bob, { ...agentA, name: "Alice" }]) {
      expect(failureOf(() => task.heartbeat(taskKey, other))).toMatchObject({ facts: { reason: "claimed" } });
    }
    expect(failureOf(() => task.claim({ taskKey, leaseMs: LEASE_MS }, bob)).message).toContain("Alice");
    task.release(taskKey, alice);

    const anonymous: Actor = { name: "Agent", email: null, kind: "agent" };
    const failure = expectRefused(taskKey, () => task.claim({ taskKey, leaseMs: LEASE_MS }, anonymous));
    expect(failure.kind).toBe("input");
    expect(failure.message).toContain("ZINN_SESSION_ID");
  });
});

test("ZINN-585: a lease is an integer from one minute through the work limit", () => {
  withClaimStore((taskKey) => {
    for (const leaseMs of [MIN_CLAIM_LEASE_MS - 1, CLAIM_WORK_LIMIT_MS + 1, MIN_CLAIM_LEASE_MS + 0.5, Number.NaN]) {
      expect(expectRefused(taskKey, () => task.claim({ taskKey, leaseMs }, agentA))).toMatchObject({
        kind: "input", facts: { field: ["leaseMs"] },
      });
    }
    expect(failureOf(() => task.claim({ taskKey } as never, agentA))).toMatchObject({ kind: "input" });

    expect(task.claim({ taskKey, leaseMs: MIN_CLAIM_LEASE_MS }, agentA).task.claim?.lease_ms).toBe(MIN_CLAIM_LEASE_MS);
    expect(task.claim({ taskKey, leaseMs: CLAIM_WORK_LIMIT_MS }, agentA).task.claim?.lease_ms).toBe(CLAIM_WORK_LIMIT_MS);
  });
});

test("ZINN-585: every task activity action by the holder renews the claim, and every one but a heartbeat counts as work", () => {
  withClaimStore((taskKey) => {
    const { id } = task.claim({ taskKey, leaseMs: LEASE_MS }, agentA).task;
    let time = START;

    for (const action of activityActionSchema.options) {
      const previous = claimRows()[0]!;
      time = at(time + MINUTE_MS);
      writeTransaction(() => recordTaskActivity(agentA, { taskId: id, action, changes: null, createdAt: time }));

      const isWork = action !== "claim_heartbeat";
      expect({ action, claim: claimRows()[0] }).toEqual({
        action,
        claim: { ...previous, renewed_at: time, worked_at: isWork ? time : previous.worked_at },
      });
    }
  });
});

test("ZINN-585: the holder's edits, comments, relations and moves renew the claim", () => {
  withClaimStore((taskKey, projectId) => {
    const other = task.create({ project_id: projectId, title: "Other" }, alice);
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    const writes = [
      () => task.edit({ taskKey, title: "Renamed" }, agentA),
      () => comment.create({ taskKey, text: "Progress" }, agentA),
      () => relation.create({ sourceTaskKey: taskKey, targetTaskKey: other.key, relation_type: "related" }, agentA),
      () => task.move({ taskKey, targetColumn: "Review" }, agentA),
    ];
    let time = START;

    for (const write of writes) {
      time = at(time + MINUTE_MS);
      write();
      expect(claimRows()[0]).toMatchObject({ renewed_at: time, worked_at: time });
    }
  });
});

test("ZINN-585: no renewal from another session, a no-op edit, a refused expected-value write or a read", () => {
  withClaimStore((taskKey) => {
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    const claimed = claimRows();
    at(START + MINUTE_MS);

    task.edit({ taskKey, title: "By someone else" }, agentB);
    task.edit({ taskKey, title: "By someone else" }, agentA);
    const stale = expectRefused(taskKey, () =>
      task.edit({ taskKey, title: "Stale", expected: { title: "Claimed" } }, agentA),
    );
    task.getByKey(taskKey);
    task.getAll();
    task.search({ query: "someone" });

    expect(stale).toMatchObject({ kind: "conflict", facts: { reason: "value_changed" } });
    expect(claimRows()).toEqual(claimed);
  });
});

test("ZINN-585: heartbeats stop extending a claim 24 hours after the holder's last work, and work revives it", () => {
  withClaimStore((taskKey) => {
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    const heartbeatInterval = LEASE_MS / 2;
    let time = START;

    while (time + heartbeatInterval < START + CLAIM_WORK_LIMIT_MS) {
      time = at(time + heartbeatInterval);
      expect(task.heartbeat(taskKey, agentA).task.claim?.expires_at).toBe(
        Math.min(time + LEASE_MS, START + CLAIM_WORK_LIMIT_MS),
      );
    }

    at(START + CLAIM_WORK_LIMIT_MS);
    expect(task.getByKey(taskKey).claim?.state).toBe("expired");
    for (const call of [() => task.heartbeat(taskKey, agentA), () => task.claim({ taskKey, leaseMs: LEASE_MS }, agentA)]) {
      expect(expectRefused(taskKey, call)).toMatchObject({
        kind: "conflict", facts: { key: taskKey, reason: "claim_limit", claimExpiresAt: START + CLAIM_WORK_LIMIT_MS },
      });
    }

    const workedAt = at(START + CLAIM_WORK_LIMIT_MS + MINUTE_MS);
    task.edit({ taskKey, title: "Back at it" }, agentA);
    expect(task.getByKey(taskKey).claim).toMatchObject({
      state: "live", worked_at: workedAt, expires_at: workedAt + LEASE_MS,
    });
    expect(task.heartbeat(taskKey, agentA).changed).toBe(true);
  });
});

test("ZINN-585: archiving and closing moves release the claim under the acting actor, a review move keeps it", () => {
  withClaimStore((taskKey, projectId) => {
    const keys = [taskKey, ...["Done", "Cancelled"].map((title) => task.create({ project_id: projectId, title }, alice).key)];
    for (const key of keys) {
      task.claim({ taskKey: key, leaseMs: LEASE_MS }, agentA);
    }

    task.move({ taskKey: keys[1]!, targetColumn: "Review" }, alice);
    expect(task.getByKey(keys[1]!).claim).not.toBeNull();

    const archived = task.archive(keys[0]!, alice);
    task.move({ taskKey: keys[1]!, targetColumn: "Done" }, alice);
    const [cancelled] = task.moveMany({ taskKeys: [keys[2]!], targetColumn: "Cancelled" }, alice);

    expect(archived.claim).toBeNull();
    expect(cancelled!.task.claim).toBeNull();
    expect(claimRows()).toEqual([]);
    for (const [key, cause] of [[keys[0]!, "archive"], [keys[1]!, "closed"], [keys[2]!, "closed"]] as const) {
      expect(claimActivity(key).at(-1)).toMatchObject({
        action: "claim_release",
        actor_name: "Alice",
        actor_kind: "human",
        changes: { actor_session_id: "session-a", cause },
      });
    }
  });
});

test("ZINN-585: deleting a task or its project removes the claim without a release record", () => {
  withClaimStore((taskKey, projectId) => {
    const other = task.create({ project_id: projectId, title: "Other" }, alice);
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    task.claim({ taskKey: other.key, leaseMs: LEASE_MS }, agentA);

    task.delete(taskKey, alice);
    expect(claimRows().map((row) => row.task_id)).toEqual([other.id]);
    project.delete("APP", alice);
    expect(claimRows()).toEqual([]);

    const releases = getDb().query("SELECT * FROM activity WHERE action = 'claim_release'").all();
    expect(releases).toEqual([]);
  });
});

test("ZINN-585: a holder with a stale expected value is refused with value_changed and the claim stays as it was", () => {
  withClaimStore((taskKey) => {
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    task.edit({ taskKey, title: "Changed" }, alice);
    const claimed = claimRows();
    at(START + MINUTE_MS);

    const failure = expectRefused(taskKey, () => task.edit({ taskKey, title: "Mine", expected: { title: "Claimed" } }, agentA));

    expect(failure).toMatchObject({ kind: "conflict", facts: { reason: "value_changed", changedFields: ["title"] } });
    expect(claimRows()).toEqual(claimed);
  });
});

test("ZINN-585: every kind of task result carries the task's claim", () => {
  withClaimStore((taskKey, projectId) => {
    const other = task.create({ project_id: projectId, title: "Other" }, alice);
    relation.create({ sourceTaskKey: taskKey, targetTaskKey: other.key, relation_type: "related" }, alice);
    task.claim({ taskKey, leaseMs: LEASE_MS }, agentA);
    const live = { state: "live", actor_session_id: "session-a" };
    const claimOf = (results: Array<{ key: string; claim: unknown }>) =>
      Object.fromEntries(results.map((result) => [result.key, result.claim == null ? null : "claimed"]));
    const both = { [taskKey]: "claimed", [other.key]: null };

    expect(claimOf(task.getAll())).toEqual(both);
    expect(claimOf(task.getPage({ limit: 1 }).tasks)).toEqual({ [taskKey]: "claimed" });
    expect(claimOf(task.search({ query: "Claimed" }).tasks)).toEqual({ [taskKey]: "claimed" });
    expect(task.next()).toMatchObject({ key: taskKey, claim: live });
    expect(task.getByKey(taskKey).claim).toMatchObject(live);
    expect(task.create({ project_id: projectId, title: "New" }, alice).claim).toBeNull();
    expect(task.edit({ taskKey, title: "Edited" }, agentA).task.claim).toMatchObject(live);
    label.create({ name: "bug" }, alice);
    expect(task.label.add({ taskKey, labelNames: ["bug"] }, agentA).task.claim).toMatchObject(live);
    expect(task.move({ taskKey, targetColumn: "Review" }, agentA).claim).toMatchObject(live);
    expect(task.moveMany({ taskKeys: [taskKey], targetColumn: "Doing" }, agentA)[0]!.task.claim).toMatchObject(live);
    expect(task.order({ taskKey, direction: "top" }, agentA).task.claim).toMatchObject(live);
    expect(task.orderMany({ taskKeys: [taskKey], direction: "bottom" }, agentA)[0]!.task.claim).toMatchObject(live);
    expect(task.unarchive(taskKey, agentA).claim).toMatchObject(live);
    expect(task.unarchiveMany([taskKey], agentA)[0]!.task.claim).toMatchObject(live);

    const [related] = relation.getAll(taskKey, { include: { tasks: true } });
    expect(claimOf([related!.source!, related!.target!])).toEqual(both);
    const [conflict] = relation.getConflicts({ sourceTaskKey: taskKey, targetTaskKey: other.key, relation_type: "dependency" });
    expect(claimOf([conflict!.source!, conflict!.target!])).toEqual(both);

    expect(task.archiveMany([taskKey], agentA)[0]!.task.claim).toBeNull();
    expect(task.deleteMany([other.key], agentA)[0]!.claim).toBeNull();
  });
});

test("ZINN-585: a task list reads its claims in one query", () => {
  withClaimStore((taskKey, projectId) => {
    for (const title of ["Second", "Third"]) {
      task.claim({ taskKey: task.create({ project_id: projectId, title }, alice).key, leaseMs: LEASE_MS }, agentA);
    }
    const reads = spyOn(dbClaim, "getByTaskIds");

    try {
      expect(task.getAll()).toHaveLength(3);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  });
});

test("ZINN-585: hooks receive the claim actions", () => {
  withTestStore((directory) => {
    const log = join(directory, "hook.log");
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ hooks: { log: { command: `cat >> '${log}'` } } }));
    withEnvironment({ ZINN_DIR: directory }, () => {
      const app = project.create({ key: "APP" }, alice);
      const { key } = task.create({ project_id: app.id, title: "Hooked" }, alice);
      task.claim({ taskKey: key, leaseMs: LEASE_MS }, agentA);
      task.claim({ taskKey: key, leaseMs: LEASE_MS, force: true }, agentB);
      task.heartbeat(key, agentB);
      task.release(key, agentB);
    });

    const actions = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).action);
    expect(actions.slice(-4)).toEqual(["claim", "claim_take", "claim_heartbeat", "claim_release"]);
  });
});

test("ZINN-585: of eight concurrent claims on one task from separate processes, one succeeds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-claims-"));

  try {
    const taskKey = withEnvironment({ ZINN_DIR: directory }, () => {
      const app = project.create({ key: "APP" }, alice);
      return task.create({ project_id: app.id, title: "Contended" }, alice).key;
    });
    const indexPath = JSON.stringify(join(import.meta.dir, "../index.ts"));
    const children = Array.from({ length: CONCURRENT_CLAIMS }, (_, index) =>
      Bun.spawn([process.execPath, "--eval", `
        const core = await import(${indexPath});
        const actor = { name: "Agent", email: null, kind: "agent", sessionId: "session-${index}" };
        try {
          core.task.claim({ taskKey: ${JSON.stringify(taskKey)}, leaseMs: ${LEASE_MS} }, actor);
          console.log(JSON.stringify({ claimed: true }));
        } catch (error) {
          console.log(JSON.stringify({ claimed: false, reason: error.facts?.reason ?? error.message }));
        }
      `], { env: { ...process.env, ZINN_DIR: directory }, stdout: "pipe", stderr: "pipe" }),
    );

    const outcomes = [];
    for (const child of children) {
      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
      outcomes.push(JSON.parse(await new Response(child.stdout).text()));
    }

    expect(outcomes.filter((outcome) => outcome.claimed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.claimed)).toEqual(
      Array.from({ length: CONCURRENT_CLAIMS - 1 }, () => ({ claimed: false, reason: "claimed" })),
    );
    withEnvironment({ ZINN_DIR: directory }, () => {
      expect(claimRows()).toHaveLength(1);
      expect(claimActivity(taskKey).map((event) => event.action)).toEqual(["claim"]);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("ZINN-585: reads on a database at the previous schema version, opened read-only, return no claims", () => {
  const home = mkdtempSync(join(tmpdir(), "zinn-claim-home-"));

  try {
    const { dataDirectory, databasePath } = storagePaths(join(home, ".zinn"));
    mkdirSync(dataDirectory, { recursive: true });
    const db = openDatabase(databasePath);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      seedBaseline(db);
      upgradeSchema(db, MIGRATIONS.filter(({ version }) => version < taskClaimMigration.version));
    } finally {
      db.close();
    }

    withEnvironment({ HOME: home, ZINN_DIR: undefined }, () => {
      expect(task.getAll().map((match) => match.claim)).toEqual([null, null, null]);
      expect(task.getPage({ archive: "all" }).tasks.map((match) => match.claim)).toEqual([null, null, null]);
      expect(task.getByKey("APP-1").claim).toBeNull();
      expect(task.next()?.claim).toBeNull();
      expect(task.search({ query: "First" }).tasks.map((match) => match.claim)).toEqual([null]);
      expect(relation.getAll("APP-1", { include: { tasks: true } })[0]!.source!.claim).toBeNull();
      expect(failureOf(() => task.claim({ taskKey: "APP-1", leaseMs: LEASE_MS }, alice))).toMatchObject({
        facts: { reason: "older_database" },
      });
    });
    expect(existsSync(join(home, ".zinn", "backups"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
