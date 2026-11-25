import type {
  Activity,
  ActivityAction,
  ActivityEntityType,
  Column,
  Comment,
  CommentWithKey,
  Label,
  Project,
  KeyedTask,
  Task,
  TaskClaim,
  TaskClaimRecord,
  TaskRelation,
  TaskWithKey,
} from "../types.js";
import type { Actor } from "../schemas/actor.js";
import type { TextEdit } from "../schemas/text-edit.js";
import type { FailureFacts } from "../errors.js";

import { readSnapshot } from "../db.js";
import { CoreError } from "../errors.js";
import { columnNameSchema } from "../schemas/column.js";
import { descriptionSchema } from "../schemas/description.js";
import { commentTextSchema } from "../schemas/comment.js";
import { CLAIM_WORK_LIMIT_MS, validateTaskInput } from "../schemas/task.js";
import { parseTaskKey, positiveIntegerPattern } from "../schemas/task.js";
import { assembleSearchEntry } from "../search-entry.js";

import * as dbProject from "../db/project.js";
import * as dbTask from "../db/task.js";
import * as dbSearch from "../db/search.js";
import * as dbLabel from "../db/label.js";
import * as dbActivity from "../db/activity.js";
import * as dbComment from "../db/comment.js";
import * as dbClaim from "../db/claim.js";

import { standardizeName, standardizeProjectKey } from "../lib.js";
import { isRecordingChange, recordChange } from "../hooks.js";

const commentKeyRegex = new RegExp(`^([^#]+)#(${positiveIntegerPattern})$`);

type ParsedTaskKey = { projectKey: string; taskNumber: number };

function findTaskByParsedKey(parsedKey: ParsedTaskKey) {
  const project = dbProject.getByKey(parsedKey.projectKey);
  if (project == null) {
    return { project: null, task: null };
  }

  const taskMatch = dbTask.getByProjectIdAndNumber({
    projectId: project.id,
    number: parsedKey.taskNumber,
  });

  return { project, task: taskMatch == null ? null : attachTaskKey(taskMatch, project.key) };
}

function requireTaskByParsedKey(parsedKey: ParsedTaskKey) {
  const { project, task } = findTaskByParsedKey(parsedKey);

  if (project == null) {
    throw new CoreError(
      `Project with key "${standardizeProjectKey(parsedKey.projectKey)}" does not exist`,
      "missing",
      { entity: "project", key: standardizeProjectKey(parsedKey.projectKey) },
    );
  }

  if (task == null) {
    throw new CoreError(`Task "${project.key}-${parsedKey.taskNumber}" does not exist`, "missing", {
      entity: "task",
      key: `${project.key}-${parsedKey.taskNumber}`,
    });
  }

  return task;
}

function requireParsedTaskKey(taskKey: string) {
  const parsedKey = parseTaskKey(taskKey);
  if (parsedKey == null) {
    throw new CoreError(`Invalid task key "${taskKey}". Expected format PROJECT-1`, "input", {
      field: ["taskKey"],
    });
  }

  return parsedKey;
}

export function getTaskByKey(taskKey: string) {
  return requireTaskByParsedKey(requireParsedTaskKey(taskKey));
}

export function readTaskByKey<T>(taskKey: string, read: (task: KeyedTask) => T): T {
  const parsedKey = requireParsedTaskKey(taskKey);
  return readSnapshot(() => read(requireTaskByParsedKey(parsedKey)));
}

export function findTaskByExactKey(query: string) {
  const parsedKey = parseTaskKey(query.trim());
  if (parsedKey == null) {
    return null;
  }

  return findTaskByParsedKey(parsedKey).task;
}

/** Rewrites a task's search row from its current title, description and comments. */
export function updateTaskSearchRecord(taskId: string) {
  dbSearch.removeTask(taskId);

  const taskMatch = dbTask.getById(taskId)!;
  const comments = dbComment.getAllByTaskId(taskId).map((commentMatch) => commentMatch.text);

  dbSearch.addTask(assembleSearchEntry(taskMatch, comments));
}

export function attachTaskKey(task: Task, projectKey?: string): KeyedTask {
  const key = projectKey ?? dbProject.getById(task.project_id)!.key;
  return { ...task, key: `${key}-${task.number}` };
}

/**
 * A claim expires at the end of its lease,
 *  or a day after its holder's last work, whichever comes first.
 * getLiveClaimCondition in db/claim.ts repeats this rule in SQL. Change both together.
 */
export function getClaimExpiry(claim: TaskClaimRecord) {
  return Math.min(claim.renewed_at + claim.lease_ms, claim.worked_at + CLAIM_WORK_LIMIT_MS);
}

export function isClaimHolder(claim: TaskClaimRecord, actor: Actor) {
  if (claim.actor_session_id != null) {
    return actor.sessionId === claim.actor_session_id;
  }

  if (claim.actor_thread_id != null) {
    return actor.threadId === claim.actor_thread_id;
  }

  return actor.kind === claim.actor_kind && actor.name === claim.actor_name;
}

export function describeClaim(claim: TaskClaimRecord) {
  return {
    actor_kind: claim.actor_kind,
    actor_name: claim.actor_name,
    actor_session_id: claim.actor_session_id,
    actor_thread_id: claim.actor_thread_id,
    claimed_at: claim.claimed_at,
    expires_at: getClaimExpiry(claim),
  };
}

function presentClaim(claim: TaskClaimRecord, now: number): TaskClaim {
  const { task_id, ...stored } = claim;
  const expiresAt = getClaimExpiry(claim);

  return { state: now < expiresAt ? "live" : "expired", ...stored, expires_at: expiresAt };
}

/** Adds each task's current claim, read in one query. */
export function attachClaims<T extends KeyedTask>(
  tasks: Array<T>,
): Array<T & Pick<TaskWithKey, "claim">> {
  const claims = dbClaim.getByTaskIds(tasks.map((taskMatch) => taskMatch.id));
  const now = Date.now();

  return tasks.map((taskMatch) => {
    const claim = claims.get(taskMatch.id);
    return { ...taskMatch, claim: claim === undefined ? null : presentClaim(claim, now) };
  });
}

export function attachClaim<T extends KeyedTask>(task: T) {
  return attachClaims([task])[0]!;
}

/** Adds the current claim to each changed task, read in one query */
export function attachChangeClaims(changes: Array<{ task: KeyedTask; changed: boolean }>) {
  const tasks = attachClaims(changes.map((change) => change.task));
  return changes.map((change, index) => ({ task: tasks[index]!, changed: change.changed }));
}

export function attachCommentKey<T extends Pick<Comment, "number">>(
  comment: T,
  taskKey: string,
): T & { key: string } {
  return { ...comment, key: `${taskKey}#${comment.number}` };
}

export function getCommentByKey(commentKey: string): CommentWithKey {
  const commentKeyMatch = commentKeyRegex.exec(commentKey);
  if (commentKeyMatch == null) {
    throw new CoreError(
      `Invalid comment key "${commentKey}". Expected format PROJECT-1#1`,
      "input",
      { field: ["commentKey"] },
    );
  }

  const parsedTaskKey = parseTaskKey(commentKeyMatch[1]!);
  if (parsedTaskKey == null) {
    throw new CoreError(
      `Invalid comment key "${commentKey}". Expected format PROJECT-1#1`,
      "input",
      { field: ["commentKey"] },
    );
  }

  const commentNumber = Number(commentKeyMatch[2]);
  return readSnapshot(() => {
    const taskMatch = requireTaskByParsedKey(parsedTaskKey);
    const commentMatch = dbComment.getByTaskIdAndNumber(taskMatch.id, commentNumber);
    if (commentMatch == null) {
      throw new CoreError(`Comment "${taskMatch.key}#${commentNumber}" does not exist`, "missing", {
        entity: "comment",
        key: `${taskMatch.key}#${commentNumber}`,
      });
    }

    return attachCommentKey(commentMatch, taskMatch.key);
  });
}

export function resolveLabels(names: Array<string>) {
  const labels = dbLabel.getAll();
  const matches = new Map<string, Label>();

  for (const name of names) {
    const match = findByName(labels, name);
    if (match == null) {
      throw new CoreError(`A label with name "${name}" does not exist`, "missing", {
        entity: "label",
        key: name,
      });
    }

    matches.set(match.id, match);
  }

  return [...matches.values()];
}

/** Returns the one record a UUID prefix matched, or throws the missing or ambiguous reference error. */
export function requireSingleIdMatch<T extends { id: string }>(
  entity: "activity" | "task",
  reference: string,
  matches: Array<T>,
) {
  if (matches.length === 0) {
    throw new CoreError(`No ${entity} matches "${reference}"`, "missing", {
      entity,
      key: reference,
    });
  }

  if (matches.length > 1) {
    const label = `${entity.charAt(0).toUpperCase()}${entity.slice(1)}`;
    const candidateIds = matches.map((match) => match.id);

    throw new CoreError(
      `${label} ID "${reference}" is ambiguous. Candidates: ${candidateIds.join(", ")}. Provide more characters`,
      "conflict",
      {
        entity,
        key: reference,
        reason: "ambiguous_reference",
        matchCount: matches.length,
        candidateIds,
      },
    );
  }

  return matches[0]!;
}

/**
 * Throws a `value_changed` conflict naming every field whose expected value differs from the stored one.
 * Fields without an expected value are not checked. `fields` sets the order of `changedFields`.
 */
export function requireExpectedValues<Field extends string>(
  entity: NonNullable<FailureFacts["entity"]>,
  key: string,
  fields: ReadonlyArray<Field>,
  expected: Partial<Record<Field, unknown>> | undefined,
  stored: Record<Field, unknown>,
) {
  if (expected === undefined) {
    return;
  }

  const changedFields = fields.filter((field) => {
    const expectedValue = expected[field];
    return expectedValue !== undefined && expectedValue !== stored[field];
  });

  if (changedFields.length > 0) {
    throw new CoreError(
      `Expected values no longer match ${key}: ${changedFields.join(", ")}`,
      "conflict",
      { entity, key, reason: "value_changed", changedFields },
    );
  }
}

export function findByName<T extends { name: string }>(matches: Array<T>, name: string) {
  return matches.find((match) => standardizeName(match.name) === standardizeName(name));
}

export function requireColumnByName(project: Project, projectColumns: Array<Column>, name: string) {
  const columnMatch = findByName(projectColumns, validateTaskInput(columnNameSchema, name));

  if (columnMatch == null) {
    // TODO: maybe a `did you mean` type of fuzzy check for misspelllings
    throw new CoreError(`${project.name} does not have a column named "${name}"`, "missing", {
      entity: "column",
      key: name,
    });
  }

  return { columnMatch, columnIndex: projectColumns.indexOf(columnMatch) };
}

export type OrderPlacement =
  | { direction: "first" | "previous" | "next" | "last" }
  | { direction: "before" | "after"; targetIndex: number };

/**
 * Picks where a reordered item lands in an ordered list of `itemCount` items.
 * `movedIndex` and `targetIndex` are positions in the full list.
 * The result is a position in the list without the moved item,
 *  so it equals `movedIndex` when the item would stay where it is.
 */
export function getInsertionIndex(
  itemCount: number,
  movedIndex: number,
  placement: OrderPlacement,
) {
  const lastIndexWithoutMoved = itemCount - 1;

  switch (placement.direction) {
    case "first":
      return 0;
    case "previous":
      return Math.max(0, movedIndex - 1);
    case "next":
      return Math.min(lastIndexWithoutMoved, movedIndex + 1);
    case "last":
      return lastIndexWithoutMoved;
    case "before":
    case "after": {
      const isTargetAfterMoved = placement.targetIndex > movedIndex;
      const targetIndexWithoutMoved = isTargetAfterMoved
        ? placement.targetIndex - 1
        : placement.targetIndex;

      return placement.direction === "before"
        ? targetIndexWithoutMoved
        : targetIndexWithoutMoved + 1;
    }
  }
}

export function recordActivity(
  actor: Actor,
  props: {
    entityType: ActivityEntityType;
    entityId: string;
    action: ActivityAction;
    changes: Activity["changes"];
    createdAt: number;
  },
) {
  const created = dbActivity.create({
    created_at: props.createdAt,
    actor_name: actor.name,
    actor_email: actor.email,
    actor_kind: actor.kind,
    actor_source: actor.source ?? null,
    actor_session_id: actor.sessionId ?? null,
    actor_thread_id: actor.threadId ?? null,
    actor_agent: actor.agent ?? null,
    actor_model: actor.model ?? null,
    actor_effort: actor.effort ?? null,
    actor_client: actor.client ?? null,
    entity_type: props.entityType,
    entity_id: props.entityId,
    action: props.action,
    changes: props.changes,
  });

  if (isRecordingChange()) {
    recordChange({ ...created, task_key: findActivityTaskKey(created) });
  }
}

/**
 * The key of the task a record is about
 * Looked up while the task still exists, or `null` for other entities.
 */
function findActivityTaskKey(record: Activity) {
  if (record.entity_type !== "task") {
    return null;
  }

  const taskMatch = dbTask.getById(record.entity_id);
  return taskMatch == null ? null : attachTaskKey(taskMatch).key;
}

export function recordTaskActivity(
  actor: Actor,
  props: {
    taskId: string;
    action: ActivityAction;
    changes: Activity["changes"];
    createdAt: number;
  },
) {
  recordActivity(actor, {
    entityType: "task",
    entityId: props.taskId,
    action: props.action,
    changes: props.changes,
    createdAt: props.createdAt,
  });
  renewHeldClaim(actor, props.taskId, props.action, props.createdAt);
}

/** Renews the task's claim when the actor holds it. Any action but a heartbeat also counts as work. */
function renewHeldClaim(actor: Actor, taskId: string, action: ActivityAction, now: number) {
  const claim = dbClaim.getByTaskId(taskId);

  if (claim == null || !isClaimHolder(claim, actor)) {
    return;
  }

  dbClaim.renew({
    task_id: taskId,
    renewed_at: now,
    worked_at: action === "claim_heartbeat" ? claim.worked_at : now,
  });
}

/** Snapshot of a relation with task keys, so history still reads after either task is deleted. */
export function describeRelation(
  relation: Pick<TaskRelation, "source_task_id" | "target_task_id" | "relation_type">,
) {
  const source = attachTaskKey(dbTask.getById(relation.source_task_id)!);
  const target = attachTaskKey(dbTask.getById(relation.target_task_id)!);

  return {
    type: relation.relation_type,
    source: { id: source.id, key: source.key },
    target: { id: target.id, key: target.key },
  };
}

/** Thrown when the text to replace does not match exactly one place, so nothing was changed. */
export class TextEditMatchError extends CoreError {
  override name = "TextEditMatchError";
  readonly matchCount: number;
  readonly target: string;

  constructor(matchCount: number, target: string, field?: string) {
    super(
      matchCount === 0
        ? `The text to replace was not found in ${target}.`
        : `The text to replace matches ${matchCount} places in ${target}. Include more of the surrounding text so it matches one place.`,
      "conflict",
      { reason: "text_match_count", matchCount, field: field === undefined ? undefined : [field] },
    );
    this.matchCount = matchCount;
    this.target = target;
  }
}

const PARAGRAPH_BREAK = "\n\n";
const trailingLineBreaksRegex = /[\r\n]+$/;

/** Applies one edit to the stored text. `target` names the text in a match error. */
export function applyTextEdit(
  current: string | null,
  edit: TextEdit,
  target: string,
  field?: string,
) {
  if ("append" in edit) {
    const existingText = (current ?? "").replace(trailingLineBreaksRegex, "");
    return existingText.length === 0 ? edit.append : existingText + PARAGRAPH_BREAK + edit.append;
  }

  // Splitting matches the text literally, so `$` patterns in the replacement stay as written.
  const parts = (current ?? "").split(edit.find);
  const matchCount = parts.length - 1;
  const isAmbiguous = matchCount > 1 && edit.all !== true;
  if (matchCount === 0 || isAmbiguous) {
    throw new TextEditMatchError(matchCount, target, field);
  }

  return parts.join(edit.replace);
}

/** The description that an edit input leads to. An edit object is applied to the current one. */
export function resolveDescription(
  input: string | null | TextEdit,
  current: string | null,
  target: string,
) {
  if (input === null || typeof input === "string") {
    return input;
  }

  return validateTaskInput(descriptionSchema, applyTextEdit(current, input, target, "description"));
}

/** The comment text an edit input leads to; an edit object is applied to the current text. */
export function resolveCommentText(input: string | TextEdit, current: string, target: string) {
  if (typeof input === "string") {
    return input;
  }

  return validateTaskInput(commentTextSchema, applyTextEdit(current, input, target, "text"));
}
