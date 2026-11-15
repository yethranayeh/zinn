import type { KeyedTask, TaskChange, TaskClaimRecord } from "../types.js";
import type { TaskClaimInput } from "../schemas/task.js";
import type { Actor } from "../schemas/actor.js";

import { CoreError } from "../errors.js";
import { writeTransaction } from "../db.js";
import { actorSchema } from "../schemas/actor.js";
import { CLAIM_WORK_LIMIT_MS, taskClaimSchema, validateTaskInput } from "../schemas/task.js";

import * as dbClaim from "../db/claim.js";

import {
  attachClaim,
  describeClaim,
  getClaimExpiry,
  getTaskByKey,
  isClaimHolder,
  recordTaskActivity,
} from "./shared.js";

const MS_PER_HOUR = 3_600_000;

/** Why a claim was released, as its `claim_release` activity records it */
export type ClaimReleaseCause = "release" | "archive" | "closed";

/** Names a claim's holder by name or kind, and the session or thread it is matched by */
function describeHolder(claim: TaskClaimRecord) {
  const name = claim.actor_name ?? claim.actor_kind;

  if (claim.actor_session_id != null) {
    return `${name} (session ${claim.actor_session_id})`;
  }

  if (claim.actor_thread_id != null) {
    return `${name} (thread ${claim.actor_thread_id})`;
  }

  return name;
}

function claimedByOther(taskMatch: KeyedTask, claim: TaskClaimRecord) {
  return new CoreError(`${taskMatch.key} is claimed by ${describeHolder(claim)}`, "conflict", {
    entity: "task",
    key: taskMatch.key,
    reason: "claimed",
    claimExpiresAt: getClaimExpiry(claim),
  });
}

/** Refuses to renew a claim whose holder recorded no work for the whole work limit */
function requireWithinWorkLimit(taskMatch: KeyedTask, claim: TaskClaimRecord, now: number) {
  const hasReachedWorkLimit = now >= claim.worked_at + CLAIM_WORK_LIMIT_MS;

  if (hasReachedWorkLimit) {
    throw new CoreError(
      `${taskMatch.key}'s claim by ${describeHolder(claim)} saw no work for ${CLAIM_WORK_LIMIT_MS / MS_PER_HOUR} hours, so only work on the task renews it`,
      "conflict",
      {
        entity: "task",
        key: taskMatch.key,
        reason: "claim_limit",
        claimExpiresAt: getClaimExpiry(claim),
      },
    );
  }
}

/** Agents are told apart by session or thread, so an agent without either cannot hold a claim */
function requireClaimIdentity(actor: Actor) {
  const hasIdentity = actor.sessionId != null || actor.threadId != null;

  if (actor.kind === "agent" && !hasIdentity) {
    throw new CoreError(
      "An agent needs a session to claim a task. Set ZINN_SESSION_ID to the agent's session",
      "input",
      { field: ["sessionId"] },
    );
  }
}

/** Renews a claim the actor holds and records the heartbeat. A lease replaces the stored one. */
function renewClaim(
  taskId: string,
  claim: TaskClaimRecord,
  actor: Actor,
  now: number,
  leaseMs: number,
) {
  dbClaim.setLease(taskId, leaseMs);
  // ! Recording the activity renews the claim
  recordTaskActivity(actor, {
    taskId,
    action: "claim_heartbeat",
    changes: { lease_ms: leaseMs, previous_expires_at: getClaimExpiry(claim) },
    createdAt: now,
  });
}

/**
 * Removes a task's claim and records its release under the acting actor
 * ! The releaser does not have the be the same as the claim holder.
 * @returns whether the task had a claim
 */
export function releaseTaskClaim(
  taskId: string,
  actor: Actor,
  cause: ClaimReleaseCause,
  now: number,
) {
  const claim = dbClaim.getByTaskId(taskId);

  if (claim == null) {
    return false;
  }

  dbClaim.deleteByTaskId(taskId);
  recordTaskActivity(actor, {
    taskId,
    action: "claim_release",
    changes: { ...describeClaim(claim), cause },
    createdAt: now,
  });

  return true;
}

export const taskClaim = {
  /**
   * Claims a task for the actor with a lease. The holder's repeated claim renews it with the new lease.
   * A live claim by another holder is a `claimed` conflict unless `force` takes it over.
   */
  claim: (input: TaskClaimInput, actor: Actor): TaskChange => {
    const props = validateTaskInput(taskClaimSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);
    requireClaimIdentity(validActor);

    return writeTransaction(() => {
      const taskMatch = getTaskByKey(props.taskKey);

      if (taskMatch.archived_at != null) {
        throw new CoreError(`Archived task "${taskMatch.key}" cannot be claimed`, "conflict", {
          entity: "task",
          key: taskMatch.key,
          reason: "archived",
        });
      }

      const now = Date.now();
      const existing = dbClaim.getByTaskId(taskMatch.id);

      if (existing != null && isClaimHolder(existing, validActor)) {
        requireWithinWorkLimit(taskMatch, existing, now);
        renewClaim(taskMatch.id, existing, validActor, now, props.leaseMs);
        return { task: attachClaim(taskMatch), changed: true };
      }

      const isTakingLiveClaim = existing != null && now < getClaimExpiry(existing);
      if (isTakingLiveClaim && props.force !== true) {
        throw claimedByOther(taskMatch, existing);
      }

      dbClaim.put({
        task_id: taskMatch.id,
        actor_kind: validActor.kind,
        actor_name: validActor.name,
        actor_session_id: validActor.sessionId ?? null,
        actor_thread_id: validActor.threadId ?? null,
        claimed_at: now,
        renewed_at: now,
        worked_at: now,
        lease_ms: props.leaseMs,
      });
      recordTaskActivity(validActor, {
        taskId: taskMatch.id,
        action: isTakingLiveClaim ? "claim_take" : "claim",
        changes: {
          lease_ms: props.leaseMs,
          replaced: existing == null ? null : describeClaim(existing),
        },
        createdAt: now,
      });

      return { task: attachClaim(taskMatch), changed: true };
    });
  },
  /** Renews the actor's claim with its stored lease. It never creates a claim. */
  heartbeat: (taskKey: string, actor: Actor): TaskChange => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const taskMatch = getTaskByKey(taskKey);
      const now = Date.now();
      const existing = dbClaim.getByTaskId(taskMatch.id);

      if (existing == null) {
        throw new CoreError(`${taskMatch.key} has no claim to renew`, "conflict", {
          entity: "task",
          key: taskMatch.key,
          reason: "not_claimed",
        });
      }

      if (!isClaimHolder(existing, validActor)) {
        throw claimedByOther(taskMatch, existing);
      }

      requireWithinWorkLimit(taskMatch, existing, now);
      renewClaim(taskMatch.id, existing, validActor, now, existing.lease_ms);

      return { task: attachClaim(taskMatch), changed: true };
    });
  },
  /** Removes the actor's claim. A task without a claim is left unchanged. */
  release: (taskKey: string, actor: Actor): TaskChange => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const taskMatch = getTaskByKey(taskKey);
      const now = Date.now();
      const existing = dbClaim.getByTaskId(taskMatch.id);

      if (existing == null) {
        return { task: attachClaim(taskMatch), changed: false };
      }

      if (!isClaimHolder(existing, validActor)) {
        throw claimedByOther(taskMatch, existing);
      }

      releaseTaskClaim(taskMatch.id, validActor, "release", now);
      return { task: attachClaim(taskMatch), changed: true };
    });
  },
};
