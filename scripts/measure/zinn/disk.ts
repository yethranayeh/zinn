/** Disk growth figures from the fixture databases. */

/** The task counts the per-task figure is measured between. */
export const PER_TASK_FROM = 1_000;
export const PER_TASK_TO = 10_000;

/** The task count whose comment fixture gives the per-comment figure. */
export const PER_COMMENT_TASKS = 10_000;

export type DiskFixtureSpec = {
  name: string;
  tasks: number;
  comments: boolean;
};

export const DISK_FIXTURES: readonly DiskFixtureSpec[] = [
  { name: `t${PER_TASK_FROM}-c0`, tasks: PER_TASK_FROM, comments: false },
  { name: `t${PER_TASK_TO}-c0`, tasks: PER_TASK_TO, comments: false },
  { name: `t${PER_COMMENT_TASKS}-c1`, tasks: PER_COMMENT_TASKS, comments: true },
];

export type DiskSlopes = {
  perTask: number;
  perComment: number;
};

/** Rounds to whole bytes, so the per-task and per-comment figures are integers. */
export function computeDiskSlopes(sizes: Readonly<Record<string, number>>): DiskSlopes {
  const perTaskFrom = sizes[`t${PER_TASK_FROM}-c0`];
  const perTaskTo = sizes[`t${PER_TASK_TO}-c0`];
  const perCommentTasks = sizes[`t${PER_COMMENT_TASKS}-c0`];
  const perCommentComments = sizes[`t${PER_COMMENT_TASKS}-c1`];
  if (
    perTaskFrom === undefined ||
    perTaskTo === undefined ||
    perCommentTasks === undefined ||
    perCommentComments === undefined
  ) {
    throw new Error("The disk figures need the 1000 and 10000 task fixtures with and without comments");
  }
  return {
    perTask: Math.round((perTaskTo - perTaskFrom) / (PER_TASK_TO - PER_TASK_FROM)),
    perComment: Math.round((perCommentComments - perCommentTasks) / PER_COMMENT_TASKS),
  };
}
