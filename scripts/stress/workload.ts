/**
 * Constants and types shared by the workers and the parent.
 * Runs under both Bun and Node, so it uses only erasable TypeScript syntax.
 */

// Wrapper workload (wrapper-worker.ts): money moves between a fixed set of accounts.
export const ACCOUNT_COUNT = 8;
export const INITIAL_BALANCE = 1000;

// Core workload (core-worker.ts): one project per mode.
export const CRASH_PROJECT_KEY = "CRASH";
export const CONTEND_PROJECT_KEY = "LOCK";
export const SEED_PROJECT_KEY = "BAK";

/** What one in-flight core operation must have done, checked by the parent when that operation committed. */
export type Expectation =
  | { kind: "task-title"; taskId: string | null; title: string }
  | { kind: "task-column"; taskId: string; column: string }
  | { kind: "task-archived"; taskId: string; archived: boolean }
  | { kind: "task-deleted"; taskId: string }
  | { kind: "comment-text"; taskId: string; text: string }
  | { kind: "comment-deleted"; taskId: string; number: number }
  | { kind: "task-label"; taskId: string; labelId: string; attached: boolean }
  | { kind: "relation"; relation: string; exists: boolean }
  | { kind: "label-name"; name: string }
  | { kind: "label-deleted"; labelId: string }
  | { kind: "project-description"; description: string }
  | { kind: "none" };

/** Lines of a log a killed process wrote, without a final line the kill may have cut short. */
export function completeLines(text: string) {
  const lines = text.split("\n");
  lines.pop();
  return lines;
}
