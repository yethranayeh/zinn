import type { TaskListInput } from "./schemas/task.js";
import type { FailureFacts } from "./errors.js";
import type { TaskSortKey, TaskSortPosition } from "./db/task.js";

import { Buffer } from "node:buffer";
import { z } from "zod";

import { CoreError } from "./errors.js";
import { getTaskSortKeys } from "./db/task.js";
import { uuidReferenceSchema } from "./schemas/uuid-reference.js";

/**
 * The token contains its format version
 * The marker keeps tokens from starting with a dash or looking like a task ID
 */
const TASK_CURSOR_MARKER = "zt";
const TASK_CURSOR_VERSION = "1";
const TASK_CURSOR_PATTERN = new RegExp(`^${TASK_CURSOR_MARKER}(\\d+)\\.(.*)$`);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type TaskCursorSort = "board" | NonNullable<TaskListInput["sort"]>;

const rankSchema = z.union([z.literal(0), z.literal(1)]);
const sortKeyValueSchemas: Record<TaskSortKey, z.ZodType<string | number>> = {
  due_null_rank: rankSchema,
  due_value: z.number().int(),
  activity_time: z.number().int(),
  project_key: z.string(),
  column_order_null_rank: rankSchema,
  column_order: z.string(),
  archive_rank: rankSchema,
  task_order_null_rank: rankSchema,
  task_order: z.string(),
  number: z.number().int(),
  id: z.string(),
};
const cursorSortSchema = z.enum(["board", "due", "activity"]);
const plainTaskIdSchema = uuidReferenceSchema("Task");

function toCursorSort(sort: TaskListInput["sort"]): TaskCursorSort {
  return sort ?? "board";
}

function refuse(message: string, reason: NonNullable<FailureFacts["reason"]>): never {
  throw new CoreError(message, "input", { field: ["startingAfter"], reason });
}

/** Makes the cursor that continues a task list after the given position */
export function encodeTaskCursor(sort: TaskListInput["sort"], position: TaskSortPosition) {
  const payload = Buffer.from(JSON.stringify([toCursorSort(sort), ...position]), "utf8");
  return `${TASK_CURSOR_MARKER}${TASK_CURSOR_VERSION}.${payload.toString("base64url")}`;
}

/** Reads a task cursor made for the given sort, refusing any other value with its own reason */
export function decodeTaskCursor(value: string, sort: TaskListInput["sort"]): TaskSortPosition {
  if (plainTaskIdSchema.safeParse(value).success) {
    refuse("Task list cursors are tokens, not task IDs", "task_id_cursor");
  }

  const match = TASK_CURSOR_PATTERN.exec(value);
  if (match == null) {
    refuse("Task cursor is malformed", "invalid_cursor");
  }

  const [, version, payload] = match;
  if (version !== TASK_CURSOR_VERSION) {
    refuse("Task cursor comes from another Zinn version", "cursor_version");
  }

  let decoded: unknown;
  try {
    if (!BASE64URL_PATTERN.test(payload!)) {
      throw new Error("Not base64url");
    }
    decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  } catch {
    refuse("Task cursor is malformed", "invalid_cursor");
  }

  const cursorSort = cursorSortSchema.safeParse(Array.isArray(decoded) ? decoded[0] : undefined);
  if (!cursorSort.success) {
    refuse("Task cursor is malformed", "invalid_cursor");
  }

  const sortName = cursorSort.data;
  const keys = getTaskSortKeys(sortName === "board" ? undefined : sortName);
  const positionSchema = z.tuple(
    keys.map((key) => sortKeyValueSchemas[key]) as [z.ZodType<string | number>],
  );
  const position = positionSchema.safeParse((decoded as Array<unknown>).slice(1));
  if (!position.success) {
    refuse("Task cursor is malformed", "invalid_cursor");
  }

  const requestedSort = toCursorSort(sort);
  if (sortName !== requestedSort) {
    refuse(
      `Task cursor was made for ${sortName} order, not ${requestedSort} order`,
      "different_sort",
    );
  }

  return position.data;
}
