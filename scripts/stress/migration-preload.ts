/**
 * Preload for the migration scenarios: `bun --preload <this file> <entry> ...`.
 * Core ships an empty migration chain, so this adds the test-only version 2 (stress-migration.ts) to it,
 *  in the child process that loads it and nowhere else. A store made without this preload is at version 1,
 *  so with it the store is older and the process upgrades it.
 *
 * It imports core's registry by file path, which is the module the CLI and core load too,
 *  so every upgrade, `zinn migrate` and fresh creation in the process sees the added migration.
 *
 * STRESS_LOCK_BUDGET_MS shortens how long an upgrade waits for the lock, so a timeout takes seconds
 *  instead of the shipped 30. Only the budget differs; the waiting and timeout code is core's own.
 */
import type { Migration } from "../../packages/core/src/migrations/registry.ts";

import { mock } from "bun:test";

import { MIGRATIONS } from "../../packages/core/src/migrations/registry.ts";
import { STRESS_MIGRATION } from "./stress-migration.ts";

(MIGRATIONS as Array<Migration>).push(STRESS_MIGRATION);

const lockBudgetMs = process.env.STRESS_LOCK_BUDGET_MS;
if (lockBudgetMs != null) {
  const upgradePath = new URL("../../packages/core/src/migrations/upgrade.ts", import.meta.url)
    .pathname;
  const upgrade = { ...(await import(upgradePath)) };

  mock.module(upgradePath, () => ({
    ...upgrade,
    upgradeDatabase: (db: unknown, options: object) =>
      upgrade.upgradeDatabase(db, { budgetMs: Number(lockBudgetMs), ...options }),
  }));
}
