import type { Bind, TaskClaimRecord } from "../types.js";

import { getDb, hasSchemaVersion } from "../db.js";
import { DB_TABLE } from "../constant.js";
import { TASK_CLAIM_VERSION } from "../migrations/task-claim.js";
import { CLAIM_WORK_LIMIT_MS } from "../schemas/task.js";

/** Whether the database has the claim table. Older schemas, still readable read-only, have no claims */
function hasClaimTable() {
  return hasSchemaVersion(TASK_CLAIM_VERSION);
}

/**
 * SQL condition with the bindings: the task under `alias` has a claim that is live at `now`.
 * Returns `null` on an older schema that would have no claims
 */
export function getLiveClaimCondition(alias: string, now: number) {
  if (!hasClaimTable()) {
    return null;
  }

  // The expiry must match `getClaimExpiry` in operations/shared.ts.
  const sql = `EXISTS (
      SELECT 1
      FROM ${DB_TABLE.taskClaim} AS claim
      WHERE claim.task_id = ${alias}.id
        AND $claim_now < MIN(claim.renewed_at + claim.lease_ms, claim.worked_at + $claim_work_limit_ms)
    )`;

  return { sql, bindings: { $claim_now: now, $claim_work_limit_ms: CLAIM_WORK_LIMIT_MS } };
}

/** Returns the claims on any of the given tasks in one query, keyed by task ID */
export function getByTaskIds(taskIds: ReadonlyArray<string>) {
  const claims = new Map<string, TaskClaimRecord>();

  if (taskIds.length === 0 || !hasClaimTable()) {
    return claims;
  }

  const rows = getDb()
    .query<TaskClaimRecord, { $taskIds: string }>(`SELECT *
    FROM ${DB_TABLE.taskClaim}
    WHERE task_id IN (SELECT value FROM json_each($taskIds))`)
    .all({ $taskIds: JSON.stringify(taskIds) });

  for (const row of rows) {
    claims.set(row.task_id, row);
  }

  return claims;
}

export function getByTaskId(taskId: string) {
  return getByTaskIds([taskId]).get(taskId) ?? null;
}

/** ! Replaces any existing claims a task has */
export function put(claim: TaskClaimRecord) {
  getDb()
    .query<never, Bind<TaskClaimRecord>>(`INSERT OR REPLACE INTO ${DB_TABLE.taskClaim}
      (task_id, actor_kind, actor_name, actor_session_id, actor_thread_id, claimed_at, renewed_at, worked_at, lease_ms)
      VALUES ($task_id, $actor_kind, $actor_name, $actor_session_id, $actor_thread_id, $claimed_at, $renewed_at, $worked_at, $lease_ms)`)
    .run({
      $task_id: claim.task_id,
      $actor_kind: claim.actor_kind,
      $actor_name: claim.actor_name,
      $actor_session_id: claim.actor_session_id,
      $actor_thread_id: claim.actor_thread_id,
      $claimed_at: claim.claimed_at,
      $renewed_at: claim.renewed_at,
      $worked_at: claim.worked_at,
      $lease_ms: claim.lease_ms,
    });
}

export function renew(props: Pick<TaskClaimRecord, "task_id" | "renewed_at" | "worked_at">) {
  getDb()
    .query<never, Bind<typeof props>>(`UPDATE ${DB_TABLE.taskClaim}
    SET renewed_at = $renewed_at, worked_at = $worked_at
    WHERE task_id = $task_id`)
    .run({ $task_id: props.task_id, $renewed_at: props.renewed_at, $worked_at: props.worked_at });
}

export function setLease(taskId: string, leaseMs: number) {
  getDb()
    .query<never, { $task_id: string; $lease_ms: number }>(
      `UPDATE ${DB_TABLE.taskClaim} SET lease_ms = $lease_ms WHERE task_id = $task_id`,
    )
    .run({ $task_id: taskId, $lease_ms: leaseMs });
}

export function deleteByTaskId(taskId: string) {
  getDb()
    .query<never, { $task_id: string }>(
      `DELETE FROM ${DB_TABLE.taskClaim} WHERE task_id = $task_id`,
    )
    .run({ $task_id: taskId });
}
