import { columnNameSchema } from "../schemas/column.js";
import type {
  Activity,
  ActivityAction,
  ActivityEntityType,
  Column,
  Comment,
  CommentWithKey,
  Label,
  Project,
  Task,
  TaskRelation,
  TaskWithKey,
} from "../types.js";
import type { Actor } from "../schemas/actor.js";
import type { TextEdit } from "../schemas/text-edit.js";

import { descriptionSchema } from "../schemas/description.js";
import { commentTextSchema } from "../schemas/comment.js";
import { validateTaskInput } from "../schemas/task.js";
import { parseTaskKey, positiveIntegerPattern } from "../schemas/task.js";
import { assembleSearchEntry } from "../search-entry.js";

import * as dbProject from "../db/project.js";
import * as dbTask from "../db/task.js";
import * as dbSearch from "../db/search.js";
import * as dbLabel from "../db/label.js";
import * as dbActivity from "../db/activity.js";
import * as dbComment from "../db/comment.js";

import { standardizeProjectKey } from "../lib.js";

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
    throw new Error(
      `Project with key "${standardizeProjectKey(parsedKey.projectKey)}" does not exist!`,
    );
  }

  if (task == null) {
    throw new Error(`Task "${project.key}-${parsedKey.taskNumber}" does not exist!`);
  }

  return task;
}

export function getTaskByKey(taskKey: string) {
  const parsedKey = parseTaskKey(taskKey);
  if (parsedKey == null) {
    throw new Error(`Invalid task key "${taskKey}". Expected format PROJECT-1`);
  }

  return requireTaskByParsedKey(parsedKey);
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

export function attachTaskKey(task: Task, projectKey?: string): TaskWithKey {
  const key = projectKey ?? dbProject.getById(task.project_id)!.key;
  return { ...task, key: `${key}-${task.number}` };
}

export function attachCommentKey(comment: Comment, taskKey: string): CommentWithKey {
  return { ...comment, key: `${taskKey}#${comment.number}` };
}

export function getCommentByKey(commentKey: string): CommentWithKey {
  const commentKeyMatch = commentKeyRegex.exec(commentKey);
  if (commentKeyMatch == null) {
    throw new Error(`Invalid comment key "${commentKey}". Expected format PROJECT-1#1`);
  }

  const parsedTaskKey = parseTaskKey(commentKeyMatch[1]!);
  if (parsedTaskKey == null) {
    throw new Error(`Invalid comment key "${commentKey}". Expected format PROJECT-1#1`);
  }

  const taskMatch = requireTaskByParsedKey(parsedTaskKey);
  const commentNumber = Number(commentKeyMatch[2]);
  const commentMatch = dbComment.getByTaskIdAndNumber(taskMatch.id, commentNumber);
  if (commentMatch == null) {
    throw new Error(`Comment "${taskMatch.key}#${commentNumber}" does not exist`);
  }

  return attachCommentKey(commentMatch, taskMatch.key);
}

export function resolveLabels(names: Array<string>) {
  const labels = dbLabel.getAll();
  const matches = new Map<string, Label>();

  for (const name of names) {
    const match = findByName(labels, name);
    if (match == null) {
      throw new Error(`A label with name "${name}" does not exist`);
    }

    matches.set(match.id, match);
  }

  return [...matches.values()];
}

export function findByName<T extends { name: string }>(matches: Array<T>, name: string) {
  return matches.find((match) => match.name.toLowerCase() === name.toLowerCase());
}

export function requireColumnByName(project: Project, projectColumns: Array<Column>, name: string) {
  const columnMatch = findByName(projectColumns, validateTaskInput(columnNameSchema, name));

  if (columnMatch == null) {
    // TODO: maybe a `did you mean` type of fuzzy check for misspelllings
    throw new Error(`${project.name} does not have a column named "${name}"`);
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
  dbActivity.create({
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
    entity_type: props.entityType,
    entity_id: props.entityId,
    action: props.action,
    changes: props.changes,
  });
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
export class TextEditMatchError extends Error {
  override name = "TextEditMatchError";
  readonly matchCount: number;
  readonly target: string;

  constructor(matchCount: number, target: string) {
    super(
      matchCount === 0
        ? `The text to replace was not found in ${target}.`
        : `The text to replace matches ${matchCount} places in ${target}. Include more of the surrounding text so it matches one place.`,
    );
    this.matchCount = matchCount;
    this.target = target;
  }
}

const PARAGRAPH_BREAK = "\n\n";
const trailingLineBreaksRegex = /[\r\n]+$/;

/** Applies one edit to the stored text. `target` names the text in a match error. */
export function applyTextEdit(current: string | null, edit: TextEdit, target: string) {
  if ("append" in edit) {
    const existingText = (current ?? "").replace(trailingLineBreaksRegex, "");
    return existingText.length === 0 ? edit.append : existingText + PARAGRAPH_BREAK + edit.append;
  }

  // Splitting matches the text literally, so `$` patterns in the replacement stay as written.
  const parts = (current ?? "").split(edit.find);
  const matchCount = parts.length - 1;
  const isAmbiguous = matchCount > 1 && edit.all !== true;
  if (matchCount === 0 || isAmbiguous) {
    throw new TextEditMatchError(matchCount, target);
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

  return descriptionSchema.parse(applyTextEdit(current, input, target));
}

/** The comment text an edit input leads to; an edit object is applied to the current text. */
export function resolveCommentText(input: string | TextEdit, current: string, target: string) {
  if (typeof input === "string") {
    return input;
  }

  return validateTaskInput(commentTextSchema, applyTextEdit(current, input, target));
}
