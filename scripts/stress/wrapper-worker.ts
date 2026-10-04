/**
 * A child process that exercises only the SQLite wrapper (packages/core/src/sqlite), under Bun or Node.
 * Core operations need Bun today, so this is the layer both runtimes share.
 * Runs as plain TypeScript under Node's type stripping, so it uses only erasable syntax and .ts imports.
 *
 * Workload: money transfers between a fixed set of accounts. Each transaction moves an amount,
 *  records the transfer, and runs up to two levels of nested transactions (savepoints) that either
 *  commit or throw. Every committed row records what it moved, so the parent can recompute every
 *  balance from the rows that exist and check the transaction was all-or-nothing.
 *
 * Modes:
 *   crash    one writer loops until killed; appends each committed sequence number to --log
 *   contend  one of several writers; commits --transactions transactions, then exits
 *   read     checks the balance total inside read transactions until --stop-file exists
 */
import { appendFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";

import type { Database } from "../../packages/core/src/sqlite/database.ts";
import { SqliteError } from "../../packages/core/src/sqlite/database.ts";
import { createRandom } from "./random.ts";
import { ACCOUNT_COUNT, INITIAL_BALANCE } from "./workload.ts";

const adapter =
  process.versions.bun != null
    ? await import("../../packages/core/src/sqlite/bun.ts")
    : await import("../../packages/core/src/sqlite/node.ts");

// The same settings Zinn's initDb uses, in the same order (packages/core/src/db.ts).
const BUSY_TIMEOUT_MS = 30_000;
// Commits that span many WAL frames, so a kill can land between frames of one transaction.
const LARGE_PAYLOAD_CHANCE = 0.01;
const LARGE_PAYLOAD_CHARACTERS = 16_000;
const SMALL_PAYLOAD_CHARACTERS = { min: 20, max: 300 };
const NESTED_CHANCE = 0.6;
const NESTED_KEEP_CHANCE = 0.6;
const MAX_NESTING_DEPTH = 2;
// Crash mode also kills during checkpoints and during close, which rewrite the main database file.
const CHECKPOINT_CHANCE = 0.03;
const REOPEN_CHANCE = 0.02;
// Contend writers reopen like short-lived CLI processes: each connection lives for a few transactions.
const MAX_TRANSACTIONS_PER_CONNECTION = 30;
// Keeps the write lock briefly after announcing it, so a kill lands inside the transaction.
const LOCK_HOLD_MS = 4;
const MAX_TRANSACTIONS_PER_PROCESS = 20_000;
const READ_PAUSE_MS = 2;

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    db: { type: "string" },
    worker: { type: "string" },
    seed: { type: "string" },
    log: { type: "string" },
    transactions: { type: "string" },
    "announce-lock": { type: "boolean" },
    "stop-file": { type: "string" },
  },
  strict: true,
});

const databasePath = values.db!;
const worker = values.worker!;
const random = createRandom(Number(values.seed ?? 1));
const runtime = process.versions.bun != null ? "bun" : "node";

class IntentionalRollback extends Error {}

function pause(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function describeError(error: unknown) {
  const code = error instanceof SqliteError ? error.code : "none";
  return `${code} ${String((error as Error).message).replaceAll("\n", " ")}`;
}

// getDb() retries these startup failures (packages/core/src/db.ts, ZINN-68). open() mirrors that policy,
//  so an error that still gets through is one Zinn would show its user.
const STARTUP_RETRY_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_RECOVERY", "SQLITE_IOERR_TRUNCATE"]);
const STARTUP_ATTEMPTS = 5;
const STARTUP_RETRY_BUDGET_MS = 1_000;
const STARTUP_BACKOFF_MS = 20;

// The statement open() is running, for error reports.
let openStep = "";

function open() {
  const began = performance.now();

  for (let attempt = 1; ; attempt++) {
    try {
      return openOnce();
    } catch (error) {
      const code = error instanceof SqliteError ? error.code : null;
      const isTransient = code != null && STARTUP_RETRY_CODES.has(code);
      const isExhausted = attempt >= STARTUP_ATTEMPTS || performance.now() - began >= STARTUP_RETRY_BUDGET_MS;

      if (!isTransient || isExhausted) {
        throw error;
      }

      console.log(`RETRY ${code} (${runtime}, open: ${openStep})`);
      pause(STARTUP_BACKOFF_MS * attempt);
    }
  }
}

function openOnce() {
  openStep = "connect";
  const db = adapter.openDatabase(databasePath);

  try {
    initialize(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function initialize(db: Database) {
  openStep = "busy_timeout";
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  openStep = "journal_mode";
  db.exec("PRAGMA journal_mode = WAL;");
  openStep = "foreign_keys";
  db.exec("PRAGMA foreign_keys = true;");
  openStep = "schema";
  db.exec(`CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS transfer (
    worker TEXT NOT NULL, seq INTEGER NOT NULL, runtime TEXT NOT NULL,
    from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, amount INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (worker, seq));`);
  db.exec(`CREATE TABLE IF NOT EXISTS step (
    worker TEXT NOT NULL, seq INTEGER NOT NULL, depth INTEGER NOT NULL, kept INTEGER NOT NULL,
    from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, amount INTEGER NOT NULL,
    PRIMARY KEY (worker, seq, depth),
    FOREIGN KEY (worker, seq) REFERENCES transfer (worker, seq));`);

  openStep = "accounts";
  const accountCount = db.query<{ count: number }>("SELECT COUNT(*) AS count FROM account").get()!.count;
  if (accountCount < ACCOUNT_COUNT) {
    db.transaction(() => {
      const insert = db.query<unknown, [number, number]>("INSERT OR IGNORE INTO account (id, balance) VALUES (?, ?)");
      for (let id = 1; id <= ACCOUNT_COUNT; id++) {
        insert.run(id, INITIAL_BALANCE);
      }
    }).immediate();
  }
}

function move(db: Database, fromId: number, toId: number, amount: number) {
  db.query<unknown, [number, number]>("UPDATE account SET balance = balance - ? WHERE id = ?").run(amount, fromId);
  db.query<unknown, [number, number]>("UPDATE account SET balance = balance + ? WHERE id = ?").run(amount, toId);
}

function pickAccounts() {
  const fromId = random.integer(1, ACCOUNT_COUNT);
  let toId = random.integer(1, ACCOUNT_COUNT - 1);
  if (toId >= fromId) {
    toId++;
  }
  return { fromId, toId, amount: random.integer(1, 50) };
}

function runNested(db: Database, seq: number, depth: number) {
  if (depth > MAX_NESTING_DEPTH || !random.chance(NESTED_CHANCE)) {
    return;
  }

  const keep = random.chance(NESTED_KEEP_CHANCE);
  const { fromId, toId, amount } = pickAccounts();

  try {
    db.transaction(() => {
      db.query<unknown, [string, number, number, number, number, number, number]>(
        "INSERT INTO step (worker, seq, depth, kept, from_id, to_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(worker, seq, depth, keep ? 1 : 0, fromId, toId, amount);
      move(db, fromId, toId, amount);
      runNested(db, seq, depth + 1);

      if (!keep) {
        throw new IntentionalRollback("nested rollback");
      }
    }).immediate();
  } catch (error) {
    if (!(error instanceof IntentionalRollback)) {
      throw error;
    }
  }
}

function runTransfer(db: Database, seq: number, announceLock: boolean) {
  const { fromId, toId, amount } = pickAccounts();
  const payloadLength = random.chance(LARGE_PAYLOAD_CHANCE) ? LARGE_PAYLOAD_CHARACTERS : random.integer(SMALL_PAYLOAD_CHARACTERS.min, SMALL_PAYLOAD_CHARACTERS.max);
  const payload = random.text(payloadLength);

  db.transaction(() => {
    if (announceLock) {
      console.log(`LOCK ${seq}`);
      pause(LOCK_HOLD_MS);
    }

    db.query<unknown, [string, number, string, number, number, number, string]>(
      "INSERT INTO transfer (worker, seq, runtime, from_id, to_id, amount, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(worker, seq, runtime, fromId, toId, amount, payload);
    move(db, fromId, toId, amount);
    runNested(db, seq, 1);
  }).immediate();
}

function nextSequence(db: Database) {
  const row = db.query<{ value: number | null }, [string]>("SELECT MAX(seq) AS value FROM transfer WHERE worker = ?").get(worker);
  return (row?.value ?? 0) + 1;
}

function runCrashMode() {
  let db = open();
  console.log("ready");

  for (let count = 0, seq = nextSequence(db); count < MAX_TRANSACTIONS_PER_PROCESS; count++, seq++) {
    runTransfer(db, seq, false);
    appendFileSync(values.log!, `${seq}\n`);

    if (random.chance(CHECKPOINT_CHANCE)) {
      db.query("PRAGMA wal_checkpoint(TRUNCATE)").all();
    }

    if (random.chance(REOPEN_CHANCE)) {
      db.close();
      db = open();
    }
  }
}

function runContendMode() {
  const transactionCount = Number(values.transactions);
  const announceLock = values["announce-lock"] === true;
  let db: Database | null = null;
  let remainingOnConnection = 0;
  // Restarted writers continue after the highest sequence number already stored.
  let seq: number | null = null;

  for (let count = 0; count < transactionCount; count++) {
    // Which step failed tells a startup race from contention on the write lock.
    let phase = "close";
    try {
      if (db == null || remainingOnConnection <= 0) {
        db?.close();
        db = null;
        phase = "open";
        db = open();
        remainingOnConnection = random.integer(1, MAX_TRANSACTIONS_PER_CONNECTION);
        if (seq == null) {
          seq = nextSequence(db);
          console.log("ready");
        }
      }

      phase = "transaction";
      const began = performance.now();
      appendFileSync(values.log!, `begin ${seq}\n`);
      runTransfer(db, seq!, announceLock);
      appendFileSync(values.log!, `ack ${seq}\n`);
      console.log(`ACK ${seq} ${Math.round(performance.now() - began)}`);
    } catch (error) {
      console.log(`ERR ${describeError(error)} (${runtime}, during ${phase === "open" ? `open: ${openStep}` : phase})`);
      // A failed open leaves no usable connection; the next transaction opens a new one.
      remainingOnConnection = 0;
    }

    if (seq != null) {
      seq++;
    }
    remainingOnConnection--;
  }

  db?.close();
  console.log("DONE");
}

function runReadMode() {
  const expectedTotal = ACCOUNT_COUNT * INITIAL_BALANCE;
  let db = open();
  let reads = 0;
  console.log("ready");

  while (!existsSync(values["stop-file"]!) && reads < MAX_TRANSACTIONS_PER_PROCESS) {
    try {
      db.exec("BEGIN");
      const total = db.query<{ total: number }>("SELECT SUM(balance) AS total FROM account").get()!.total;
      const discarded = db.query<{ count: number }>("SELECT COUNT(*) AS count FROM step WHERE kept = 0").get()!.count;
      db.exec("COMMIT");
      reads++;

      if (total !== expectedTotal || discarded !== 0) {
        console.log(`READBAD total=${total} discardedSteps=${discarded}`);
      }
    } catch (error) {
      console.log(`ERR ${describeError(error)}`);
      if (db.inTransaction) {
        db.exec("ROLLBACK");
      }
    }

    if (random.chance(REOPEN_CHANCE)) {
      db.close();
      db = open();
    }
    pause(READ_PAUSE_MS);
  }

  db.close();
  console.log(`DONE reads=${reads}`);
}

if (values.mode === "crash") {
  runCrashMode();
} else if (values.mode === "contend") {
  runContendMode();
} else if (values.mode === "read") {
  runReadMode();
} else {
  throw new Error(`Unknown mode: ${values.mode}`);
}
