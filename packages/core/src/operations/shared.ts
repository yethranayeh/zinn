import type {
  Activity,
  ActivityAction,
  Column,
  Comment,
  CommentWithKey,
  Task,
  TaskRelation,
  TaskWithKey,
} from "../types";
import { projectKeyPattern } from "../schemas/project";
import type { Actor } from "../schemas/actor";
import { positiveIntegerPattern } from "../schemas/task";

import * as dbProject from "../db/project";
import * as dbTask from "../db/task";
import * as dbSearch from "../db/search";
import * as dbLabel from "../db/label";
import * as dbActivity from "../db/activity";
import * as dbComment from "../db/comment";

import { standardizeProjectKey } from "../lib";

const taskKeyRegex = new RegExp(`^(${projectKeyPattern})-(${positiveIntegerPattern})$`);
const commentKeyRegex = new RegExp(`^([^#]+)#(${positiveIntegerPattern})$`);

function parseTaskKey(taskKey: string) {
  const taskKeyMatch = taskKeyRegex.exec(taskKey);
  if (taskKeyMatch == null) {
    return null;
  }

  return { projectKey: taskKeyMatch[1]!, taskNumber: Number(taskKeyMatch[2]) };
}

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
  dbSearch.addTask({
    taskId,
    title: taskMatch.title,
    description: taskMatch.description,
    comments: comments.join("\n"),
  });
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
  const uniqueNames = [...new Set(names)];
  return uniqueNames.map((name) => {
    const match = dbLabel.getByName(name);
    if (match == null) {
      throw new Error(`A label with name "${name}" does not exist`);
    }

    return match;
  });
}

/** Column names are matched within a project without case-sensitivity. */
export function findColumnByName(columns: Array<Column>, name: string) {
  return columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
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
export function getInsertionIndex(itemCount: number, movedIndex: number, placement: OrderPlacement) {
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

export function recordTaskActivity(
  actor: Actor,
  props: {
    taskId: string;
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
    entity_type: "task",
    entity_id: props.taskId,
    action: props.action,
    changes: props.changes,
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
