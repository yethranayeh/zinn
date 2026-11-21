import type { ChildEnvironment } from "./data.ts";
import type { Ctx, Loaded, TaskClaim } from "./types.ts";

import { CLI_READ_TIMEOUT_MS, log, runZinn } from "./data.ts";
import { claimHolder } from "./rows.ts";

/** A claim is renewed once at least this share of its lease has passed. */
export const RENEW_LEASE_SHARE = 0.5;
/** Heartbeat refusals that will not change without the conversation acting again. */
export const RENEW_REFUSALS: ReadonlySet<string> = new Set([
  "claimed",
  "claim_limit",
  "not_claimed",
]);

export type ClaimRow = {
  claim: TaskClaim | null;
};

/**
 * Keys of this conversation's claims due a heartbeat at `now`.
 * A claim that expired is never due, because a heartbeat would revive it.
 * `localRenewals` holds the times this panel renewed a key, so a board read that has not caught up
 * cannot make the next tool turn renew again before half the lease passes.
 */
export function renewalsDue(
  tasks: ReadonlyMap<string, ClaimRow>,
  family: ReadonlySet<string>,
  now: number,
  localRenewals: ReadonlyMap<string, number>,
  stopped: ReadonlySet<string> = new Set(),
): string[] {
  const due: string[] = [];

  for (const [key, task] of tasks) {
    const claim = task.claim;
    if (claim === null || stopped.has(key) || claim.leaseMs === null || claim.renewedAt === null) {
      continue;
    }
    // The row's expiry is stale after this panel renewed. Its own lease extension decides until a read catches up.
    const local = localRenewals.get(key);
    const renewedAt = Math.max(claim.renewedAt, local ?? claim.renewedAt);
    const leaseExpiry = renewedAt + claim.leaseMs;
    const expiresAt =
      local === undefined
        ? claim.expiresAt
        : Math.max(claim.expiresAt ?? leaseExpiry, leaseExpiry);
    if (expiresAt !== null && expiresAt <= now) {
      continue;
    }
    if (claimHolder({ ...claim, expiresAt }, family, now) !== "mine") {
      continue;
    }
    if (now - renewedAt < claim.leaseMs * RENEW_LEASE_SHARE) {
      continue;
    }
    due.push(key);
  }

  return due.sort();
}

/** The heartbeat identity: the claim's session, or its thread when the row has no session. */
export function holderEnvironment(claim: TaskClaim): ChildEnvironment | null {
  if (claim.sessionId !== null) {
    return { ZINN_SESSION_ID: claim.sessionId, ZINN_THREAD_ID: null };
  }
  if (claim.threadId !== null) {
    return { ZINN_SESSION_ID: null, ZINN_THREAD_ID: claim.threadId };
  }
  return null;
}

/** The toast for a refused heartbeat. The conversation stops renewing that key afterwards. */
export function refusalText(key: string, reason: string): string {
  if (reason === "claimed") {
    return `zinn: ${key} is claimed by another holder. This conversation no longer renews it.`;
  }
  if (reason === "claim_limit") {
    return `zinn: the claim on ${key} saw no work on the task for 24 hours. Only work on the task renews it now.`;
  }
  if (reason === "not_claimed") {
    return `zinn: ${key} has no claim to renew any more. This conversation no longer renews it.`;
  }
  return `zinn: could not renew the claim on ${key}.`;
}

/** One heartbeat call, injectable for tests. */
export type RenewRun = (
  args: string[],
  timeoutMs?: number,
  environment?: ChildEnvironment,
) => Promise<Loaded<string>>;

export type RenewInput = {
  ctx: Ctx;
  tasks: ReadonlyMap<string, ClaimRow>;
  family: ReadonlySet<string>;
  localRenewals: Map<string, number>;
  stopped: Set<string>;
  now?: number;
  alive?: () => boolean;
  run?: RenewRun;
};

/**
 * Renews every due claim this conversation holds, one CLI call per key.
 * A refusal toasts once and stops that key. A missing CLI or a timeout is logged and retried at the next due turn.
 */
export async function renewDueClaims(input: RenewInput): Promise<void> {
  const now = input.now ?? Date.now();
  const due = renewalsDue(input.tasks, input.family, now, input.localRenewals, input.stopped);
  log(input.ctx, "claim renewal due", { claims: input.tasks.size, due: due.length, keys: due });
  const stoppedNow = () => input.alive !== undefined && !input.alive();
  const run = input.run ?? runZinn;

  for (const key of due) {
    if (stoppedNow()) {
      return;
    }
    const claim = input.tasks.get(key)?.claim ?? null;
    const environment = claim === null ? null : holderEnvironment(claim);
    if (environment === null) {
      log(input.ctx, "claim renewal skipped", { key, reason: "no holder identity" });
      continue;
    }

    const result = await run(
      ["task", "heartbeat", key, "--json"],
      CLI_READ_TIMEOUT_MS,
      environment,
    );
    if (stoppedNow()) {
      return;
    }
    if (result.ok) {
      input.localRenewals.set(key, Date.now());
      log(input.ctx, "claim renewed", { key });
      continue;
    }

    log(input.ctx, "claim renewal failed", {
      key,
      code: result.code ?? null,
      reason: result.reason ?? null,
      error: result.error,
    });
    if (result.reason === undefined || !RENEW_REFUSALS.has(result.reason)) {
      continue;
    }

    input.stopped.add(key);
    input.ctx.ui.toast.show({
      variant: "warning",
      title: "Zinn",
      message: refusalText(key, result.reason),
    });
  }
}
