/**
 * Parent-side checks for the wrapper workload in wrapper-worker.ts.
 */
import type { Database } from "../../packages/core/src/sqlite/database.ts";

import { existsSync, readFileSync } from "node:fs";

import { ACCOUNT_COUNT, completeLines, INITIAL_BALANCE } from "./workload.ts";

type Movement = { from_id: number; to_id: number; amount: number };

function firstValues(rows: Array<unknown>) {
  return rows.map((row) => String(Object.values(row as Record<string, unknown>)[0]));
}

/**
 * Integrity, the balance total, and all-or-nothing: every balance must equal what the stored
 *  transfer and step rows say was moved. A transaction that landed half-way breaks that equality.
 */
export function checkWrapperDatabase(db: Database) {
  const problems: Array<string> = [];

  const integrity = firstValues(db.query("PRAGMA integrity_check").all());
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    problems.push(`integrity_check: ${integrity.slice(0, 5).join("; ")}`);
  }

  const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    problems.push(`foreign_key_check: ${foreignKeyViolations.length} violation(s)`);
  }

  const tables = new Set(firstValues(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()));
  if (!tables.has("account") || !tables.has("transfer") || !tables.has("step")) {
    // A kill before the first schema commit leaves no tables; there is nothing else to check.
    return { problems, sequencesByWorker: new Map<string, Set<number>>() };
  }

  const balances = db.query<{ id: number; balance: number }>("SELECT id, balance FROM account ORDER BY id").all();
  const expected = new Map<number, number>();
  for (let id = 1; id <= ACCOUNT_COUNT; id++) {
    expected.set(id, INITIAL_BALANCE);
  }

  const movements = [
    ...db.query<Movement>("SELECT from_id, to_id, amount FROM transfer").all(),
    ...db.query<Movement>("SELECT from_id, to_id, amount FROM step").all(),
  ];
  for (const movement of movements) {
    expected.set(movement.from_id, expected.get(movement.from_id)! - movement.amount);
    expected.set(movement.to_id, expected.get(movement.to_id)! + movement.amount);
  }

  if (balances.length > 0 && balances.length !== ACCOUNT_COUNT) {
    problems.push(`${balances.length} accounts instead of ${ACCOUNT_COUNT}`);
  }
  for (const account of balances) {
    if (account.balance !== expected.get(account.id)) {
      problems.push(`account ${account.id}: balance ${account.balance}, but stored rows add up to ${expected.get(account.id)}`);
    }
  }

  const discarded = db.query<{ count: number }>("SELECT COUNT(*) AS count FROM step WHERE kept = 0").get()!.count;
  if (discarded > 0) {
    problems.push(`${discarded} rolled-back savepoint row(s) are present`);
  }

  const orphanedInner = db
    .query<{ count: number }>(`SELECT COUNT(*) AS count FROM step AS inner_step WHERE depth = 2
    AND NOT EXISTS (SELECT 1 FROM step AS outer_step
      WHERE outer_step.worker = inner_step.worker AND outer_step.seq = inner_step.seq AND outer_step.depth = 1)`)
    .get()!.count;
  if (orphanedInner > 0) {
    problems.push(`${orphanedInner} inner savepoint row(s) survived without their outer savepoint`);
  }

  const sequencesByWorker = new Map<string, Set<number>>();
  for (const row of db.query<{ worker: string; seq: number }>("SELECT worker, seq FROM transfer").all()) {
    const sequences = sequencesByWorker.get(row.worker) ?? new Set<number>();
    sequences.add(row.seq);
    sequencesByWorker.set(row.worker, sequences);
  }

  return { problems, sequencesByWorker };
}

/** Sequence numbers from a worker log. Crash logs hold bare numbers; contend logs hold "begin n" and "ack n". */
export function readWorkerLog(path: string) {
  const acknowledged = new Set<number>();
  const begun = new Set<number>();

  if (!existsSync(path)) {
    return { acknowledged, begun };
  }

  for (const line of completeLines(readFileSync(path, "utf8"))) {
    const [first, second] = line.split(" ");
    if (first === "begin") {
      begun.add(Number(second));
    } else if (first === "ack") {
      acknowledged.add(Number(second));
    } else {
      acknowledged.add(Number(first));
    }
  }

  return { acknowledged, begun };
}
