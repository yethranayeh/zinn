import type { Stop } from "./page-figures";

/** Last slider position, one step per thousandth of the track */
export const lastPosition = 1000;

/** Powers of ten between 1 and 10,000 tasks */
const taskPowersOfTen = 4;

const numericFields = [
  "databaseBytes",
  "seconds",
  "memoryBytes",
  "outputBytes",
  "jsonOutputBytes",
] as const;

export function tasksAt(position: number) {
  return Math.round(10 ** ((taskPowersOfTen * position) / lastPosition));
}

export type TaskBucket = "1-9" | "10-99" | "100-999" | "1000-9999" | "10000+";

/** Fixed label for the task count at a slider position, used as event data */
export function tasksBucket(tasks: number): TaskBucket {
  if (tasks < 10) {
    return "1-9";
  }
  if (tasks < 100) {
    return "10-99";
  }
  if (tasks < 1000) {
    return "100-999";
  }
  if (tasks < 10000) {
    return "1000-9999";
  }
  return "10000+";
}

export function positionOf(tasks: number) {
  return Math.round((lastPosition * Math.log10(tasks)) / taskPowersOfTen);
}

export function figuresAt(stops: Array<Stop>, tasks: number): Stop & { exact: boolean } {
  const measured = stops.find((stop) => stop.tasks === tasks);
  if (measured) {
    return { ...measured, exact: true };
  }

  const upper = stops.findIndex((stop) => stop.tasks > tasks);
  const low = stops[upper - 1];
  const high = stops[upper];
  const share = (tasks - low.tasks) / (high.tasks - low.tasks);
  const interpolated = { ...low, tasks, exact: false };

  for (const field of numericFields) {
    const value = low[field] + (high[field] - low[field]) * share;
    interpolated[field] = field === "seconds" ? value : Math.round(value);
  }

  return interpolated;
}
