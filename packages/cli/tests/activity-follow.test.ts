import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { TELEMETRY_FOLDER_NAME } from "../../core/src/constant";
import { latestVersion, MIGRATIONS } from "../../core/src/migrations/registry";
import { errorDocumentSchema } from "../src/errors";
import { activitySchema } from "../src/result-schemas";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir } from "../test-helpers";

// ZINN-328. Each case spawns the real bin as the follower and commits through other processes.

// The follower polls once a second, so every round trip takes about that long.
const CASE_TIMEOUT_MS = 60_000;
// Longer than one poll, so a follower that is ready prints a probe before the next one is committed.
const PROBE_WAIT_MS = 2_500;
const MAX_PROBES = 10;
const WAIT_STEP_MS = 50;
// Outlasts a follower's short reads. A read transaction held between polls would outlast it.
const CHECKPOINT_BUSY_TIMEOUT_MS = 5_000;
// The control reader never lets go, so waiting longer for it proves nothing more.
const HELD_READER_BUSY_TIMEOUT_MS = 200;

type Running = ReturnType<typeof collect>;
type Start = (command: Array<string>, extraEnv?: Record<string, string>) => Running;

/** A store for one case. The processes the case starts are ended with it, since cases run side by side. */
async function withFollowedStore(run: (dir: string, start: Start) => Promise<void>) {
  await withIsolatedZinnDir(async (dir) => {
    const started: Array<Running> = [];
    try {
      await run(dir, (command, extraEnv) => {
        const running = collect(command, dir, extraEnv);
        started.push(running);
        return running;
      });
    } finally {
      for (const { proc } of started) {
        proc.kill("SIGKILL");
      }
    }
  });
}

function environment(dir: string, extra: Record<string, string> = {}) {
  return { ...TEST_ENVIRONMENT, ...extra, ZINN_DIR: dir, AI_AGENT: "follow-test" };
}

/** Collects a process's stdout as it arrives, since a follower never ends by itself */
function collect(command: Array<string>, dir: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(command, { env: environment(dir, extraEnv), cwd: dir, stdout: "pipe", stderr: "pipe" });
  let stdout = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
    }
  })();
  const stderr = new Response(proc.stderr).text();
  return {
    proc,
    text: () => stdout,
    lines: () => stdout.split("\n").filter((line) => line.length > 0),
    ended: async () => {
      await proc.exited;
      await reading;
      return { code: proc.exitCode, signal: proc.signalCode, stdout, stderr: await stderr };
    },
  };
}

function followCommand(args: Array<string> = []) {
  return [process.execPath, CLI_PATH, "activity", "list", "--follow", ...args];
}

async function waitFor(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      return false;
    }
    await Bun.sleep(WAIT_STEP_MS);
  }
  return true;
}

async function zinn(dir: string, args: Array<string>) {
  const result = await runZinn([...args, "--json"], dir, { AI_AGENT: "follow-test" });
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function createTask(dir: string, title: string, project = "APP") {
  return zinn(dir, ["task", "create", project, "--title", title]);
}

/**
 * Commits probes until the follower prints one. A follower prints nothing when it starts,
 *  so a printed probe is the only sign that it follows.
 */
async function untilFollowing(follower: Running, probe: () => Promise<unknown>) {
  for (let attempt = 0; attempt < MAX_PROBES; attempt++) {
    await probe();
    if (await waitFor(() => follower.lines().length > 0, PROBE_WAIT_MS)) {
      return;
    }
  }
  throw new Error("The follower printed no probe");
}

/** Commits one event through a connection of the caller's, with the columns every schema version has */
function insertEvent(db: Database, id: string) {
  db.run(
    "INSERT INTO activity (id, created_at, actor_name, actor_kind, entity_type, entity_id, action) VALUES (?, ?, 'Follow test', 'agent', 'task', ?, 'edit')",
    [id, Date.now(), "11111111-1234-7000-8000-123456abcdef"],
  );
  return id;
}

function followedEvents(follower: Running) {
  return follower.lines().map((line) => activitySchema.parse(JSON.parse(line)));
}

/** Waits until the follower's newest line is the event for which isLast holds */
async function untilPrinted(follower: Running, isLast: (event: ReturnType<typeof followedEvents>[number]) => boolean) {
  const printed = await waitFor(() => {
    const last = followedEvents(follower).at(-1);
    return last !== undefined && isLast(last);
  }, PROBE_WAIT_MS * 2);
  expect(printed, follower.text()).toBe(true);
}

async function expectStoppedWithDatabaseError(follower: Running, dir: string) {
  const ended = await follower.ended();
  expect(ended.code).toBe(1);
  expect(ended.signal).toBeNull();
  const { error } = errorDocumentSchema.parse(JSON.parse(ended.stderr));
  expect(error.code).toBe("conflict");
  expect(error.details?.entity).toBe("database");
  expect(error.details?.databasePath).toEndWith(join("data", "zinn.sqlite"));
  expect(error.details?.databasePath).toContain(dir.split("/").at(-1)!);
}

test("a follower prints each event other processes commit, oldest first, and nothing from before it started", async () => {
  await withFollowedStore(async (dir, start) => {
    await zinn(dir, ["project", "create", "APP"]);
    await createTask(dir, "Before the follower");
    const earlierIds = (await zinn(dir, ["activity", "list"])).map((event: { id: string }) => event.id);

    const jsonFollower = start(followCommand(["--json"]));
    const textFollower = start(followCommand());
    await untilFollowing(jsonFollower, () => createTask(dir, "probe"));
    await untilFollowing(textFollower, () => createTask(dir, "probe"));

    const landed = await createTask(dir, "Landed while following");
    await zinn(dir, ["task", "move", landed.key, "Review"]);
    await zinn(dir, ["task", "comment", "create", landed.key, "--text", "Seen by the follower"]);
    await untilPrinted(jsonFollower, (event) => event.action === "comment_create" && event.entity_id === landed.id);

    // Every line is one complete record, and together they are the newest activity in commit order.
    const followed = followedEvents(jsonFollower);
    const recorded = (await zinn(dir, ["activity", "list"])).reverse();
    const firstFollowed = recorded.findIndex((event: { id: string }) => event.id === followed[0]!.id);
    expect(firstFollowed).toBeGreaterThanOrEqual(earlierIds.length);
    expect(followed).toEqual(recorded.slice(firstFollowed));
    expect(followed.filter((event) => event.entity_id === landed.id).map((event) => event.action))
      .toEqual(["create", "move", "comment_create"]);
    for (const id of earlierIds) {
      expect(jsonFollower.text()).not.toContain(id);
    }

    expect(await waitFor(() => textFollower.text().includes("Seen by the follower"), PROBE_WAIT_MS * 2)).toBe(true);
    expect(textFollower.text()).toContain(landed.key);
    expect(textFollower.text()).not.toContain("Before the follower");
  });
}, CASE_TIMEOUT_MS);

test("a follower applies the listing's filters to new activity, including tasks created after it started", async () => {
  await withFollowedStore(async (dir, start) => {
    await zinn(dir, ["project", "create", "APP"]);
    await zinn(dir, ["project", "create", "OTH"]);
    const moveToReview = async (title: string, project: string) => {
      const created = await createTask(dir, title, project);
      await zinn(dir, ["task", "move", created.key, "Review"]);
      return created;
    };

    const follower = start(followCommand(["--project", "APP", "--changed", "column=Review", "--json"]));
    await untilFollowing(follower, () => moveToReview("probe", "APP"));

    await moveToReview("Other project", "OTH");
    const edited = await createTask(dir, "Edited only");
    await zinn(dir, ["task", "edit", edited.key, "--priority", "high"]);
    const selected = await moveToReview("Created after the follower started", "APP");
    await untilPrinted(follower, (event) => event.entity_id === selected.id);

    const followed = followedEvents(follower);
    const appTaskIds = new Set((await zinn(dir, ["task", "list", "APP"])).map((item: { id: string }) => item.id));
    for (const event of followed) {
      expect(event.action).toBe("move");
      expect(appTaskIds.has(event.entity_id)).toBe(true);
    }
    expect(followed.some((event) => event.entity_id === edited.id)).toBe(false);
  });
}, CASE_TIMEOUT_MS);

test("the WAL file can be checkpointed and reset while a follower runs", async () => {
  await withFollowedStore(async (dir, start) => {
    await zinn(dir, ["project", "create", "APP"]);
    const follower = start(followCommand(["--json"]));
    await untilFollowing(follower, () => createTask(dir, "probe"));

    // This connection stays open, so its write stays in the WAL file until a checkpoint moves it.
    const walPath = join(dir, "data", "zinn.sqlite-wal");
    const writer = new Database(join(dir, "data", "zinn.sqlite"));
    try {
      writer.run(`PRAGMA busy_timeout = ${CHECKPOINT_BUSY_TIMEOUT_MS}`);
      const fromWal = insertEvent(writer, "00000000-0000-7000-8000-0000000000aa");
      expect(statSync(walPath).size).toBeGreaterThan(0);
      // TRUNCATE succeeds only once no reader still needs the WAL file, then empties it.
      // A reader that keeps its transaction open blocks it, which a follower must not do between polls.
      const heldReader = new Database(join(dir, "data", "zinn.sqlite"), { readonly: true });
      try {
        heldReader.run("BEGIN");
        heldReader.query("SELECT COUNT(*) FROM activity").get();
        await untilPrinted(follower, (event) => event.id === fromWal);
        writer.run(`PRAGMA busy_timeout = ${HELD_READER_BUSY_TIMEOUT_MS}`);
        expect(writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 1 });
      } finally {
        heldReader.close();
      }

      writer.run(`PRAGMA busy_timeout = ${CHECKPOINT_BUSY_TIMEOUT_MS}`);
      expect(writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({ busy: 0, log: 0, checkpointed: 0 });
      expect(statSync(walPath).size).toBe(0);
    } finally {
      writer.close();
    }

    const afterReset = await createTask(dir, "After the reset");
    await untilPrinted(follower, (event) => event.entity_id === afterReset.id);
  });
}, CASE_TIMEOUT_MS);

test("an interrupt ends a follower by its signal, with a run record and nothing on stderr", async () => {
  await withFollowedStore(async (dir, start) => {
    await zinn(dir, ["project", "create", "APP"]);
    const follower = start(followCommand(["--json"]));
    await untilFollowing(follower, () => createTask(dir, "probe"));

    follower.proc.kill("SIGINT");
    const ended = await follower.ended();

    expect(ended.signal).toBe("SIGINT");
    expect(ended.code).toBeNull();
    expect(ended.stderr).toBe("");
    for (const line of ended.stdout.split("\n").filter((text) => text.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const recordFolder = join(dir, TELEMETRY_FOLDER_NAME);
    const records = readdirSync(recordFolder)
      .flatMap((name) => readFileSync(join(recordFolder, name), "utf8").trim().split("\n"))
      .map((line) => JSON.parse(line));
    const followRuns = records.filter((record) => record.options.some((option: { name: string }) => option.name === "--follow"));
    expect(followRuns).toHaveLength(1);
    expect(followRuns[0].command.route).toBe("activity list");

    // The database is whole and accepts the next write.
    await createTask(dir, "After the interrupt");
    const db = new Database(join(dir, "data", "zinn.sqlite"), { readonly: true });
    try {
      expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally {
      db.close();
    }
  });
}, CASE_TIMEOUT_MS);

test("a follower piped into head -1 ends successfully once its output is closed", async () => {
  await withFollowedStore(async (dir, start) => {
    await zinn(dir, ["project", "create", "APP"]);
    const statusPath = join(dir, "follower-status");
    // The follower's own exit status goes to a file, since the pipeline reports head's.
    const pipeline = start(
      ["/bin/sh", "-c", '{ "$@"; echo $? > "$FOLLOWER_STATUS"; } | head -1', "follow-pipe", ...followCommand(["--json"])],
      { FOLLOWER_STATUS: statusPath },
    );
    await untilFollowing(pipeline, () => createTask(dir, "probe"));

    // head has left. The follower learns of it when it writes the next event.
    for (let attempt = 0; attempt < MAX_PROBES && !existsSync(statusPath); attempt++) {
      await createTask(dir, "Written to the closed pipe");
      await waitFor(() => existsSync(statusPath), PROBE_WAIT_MS);
    }

    const ended = await pipeline.ended();
    expect(readFileSync(statusPath, "utf8").trim()).toBe("0");
    expect(ended.code).toBe(0);
    expect(ended.stderr).toBe("");
    expect(followedEvents(pipeline)).toHaveLength(1);
  });
}, CASE_TIMEOUT_MS);

test("a restore ends a follower with an error naming the database", async () => {
  await withFollowedStore(async (dir, start) => {
    await zinn(dir, ["project", "create", "APP"]);
    const follower = start(followCommand(["--json"]));
    await untilFollowing(follower, () => createTask(dir, "probe"));

    const backup = await zinn(dir, ["backup"]);
    await zinn(dir, ["restore", backup.path, "--yes"]);

    await expectStoppedWithDatabaseError(follower, dir);
  });
}, CASE_TIMEOUT_MS);

// A build opens an older database by upgrading it, so a migration under a running follower comes
//  from a newer build. Its work is stood in for here: a version bump with and without a table change.
for (const [migration, statements] of [
  ["that changes a table", ["ALTER TABLE activity ADD COLUMN added_by_newer_build TEXT"]],
  ["that changes rows only", []],
] as const) {
  test(`a migration ${migration} ends a follower with an error naming the database`, async () => {
    await withFollowedStore(async (dir, start) => {
      await zinn(dir, ["project", "create", "APP"]);
      const follower = start(followCommand(["--json"]));
      await untilFollowing(follower, () => createTask(dir, "probe"));

      const db = new Database(join(dir, "data", "zinn.sqlite"));
      try {
        db.transaction(() => {
          for (const statement of statements) {
            db.run(statement);
          }
          db.run(`PRAGMA user_version = ${latestVersion(MIGRATIONS) + 1}`);
        })();
      } finally {
        db.close();
      }

      await expectStoppedWithDatabaseError(follower, dir);
    });
  }, CASE_TIMEOUT_MS);
}

test("moving the database file away ends a follower with an error naming the database", async () => {
  await withFollowedStore(async (dir, start) => {
    await zinn(dir, ["project", "create", "APP"]);
    const follower = start(followCommand(["--json"]));
    await untilFollowing(follower, () => createTask(dir, "probe"));

    renameSync(join(dir, "data", "zinn.sqlite"), join(dir, "data", "moved.sqlite"));

    await expectStoppedWithDatabaseError(follower, dir);
  });
}, CASE_TIMEOUT_MS);

test("--limit with --follow is refused before anything is followed", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await zinn(dir, ["project", "create", "APP"]);
    for (const mode of [[], ["--json"]]) {
      const result = await runProcessAsync(
        [process.execPath, CLI_PATH, "activity", "list", "--follow", "--limit", "1", ...mode],
        { env: environment(dir), cwd: dir, timeoutMs: 20_000 },
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      if (mode.length > 0) {
        const { error } = errorDocumentSchema.parse(JSON.parse(result.stderr));
        expect(error.code).toBe("invalid_input");
        expect(error.details?.argument).toBe("--limit");
      } else {
        expect(result.stderr).toContain("--limit");
        expect(result.stderr).toContain("--follow");
      }
    }
  });
}, CASE_TIMEOUT_MS);
