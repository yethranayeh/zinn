import type {
  Activity,
  ActivityAction,
  Column,
  Comment,
  CommentWithKey,
  Task,
  TaskRelation,
  TaskWithKey,
} from "./src/types";
import type { ProjectCreateInput, ProjectEditInput } from "./src/schemas/project";
import { projectKeyPattern } from "./src/schemas/project";
import type { TaskCreateInput, TaskEditInput, TaskSearchInput } from "./src/schemas/task";
import type { RelationCreateInput, RelationDeleteInput } from "./src/schemas/relation";
import type {
  LabelCreateInput,
  LabelDeleteInput,
  LabelEditInput,
  TaskLabelInput,
} from "./src/schemas/label";
import type { Actor } from "./src/schemas/actor";
import type {
  CommentCreateInput,
  CommentDeleteInput,
  CommentEditInput,
} from "./src/schemas/comment";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

import { getDb } from "./src/db";
import {
  labelCreateSchema,
  labelDeleteSchema,
  labelEditSchema,
  taskLabelSchema,
} from "./src/schemas/label";

import * as dbProject from "./src/db/project";
import * as dbColumn from "./src/db/column";
import * as dbTask from "./src/db/task";
import * as dbRelation from "./src/db/relation";
import * as dbLabel from "./src/db/label";
import * as dbActivity from "./src/db/activity";
import * as dbComment from "./src/db/comment";

import { standardizeProjectKey } from "./src/lib";
import {
  validateTaskInput,
  taskCreateSchema,
  taskEditSchema,
  taskSearchSchema,
  positiveIntegerPattern,
} from "./src/schemas/task";
import { relationCreateSchema, relationDeleteSchema } from "./src/schemas/relation";
import { actorSchema } from "./src/schemas/actor";
import { commentCreateSchema, commentDeleteSchema, commentEditSchema } from "./src/schemas/comment";

import {
  validateProjectInput,
  projectCreateSchema,
  projectEditSchema,
} from "./src/schemas/project";

export type { ProjectCreateInput, ProjectEditInput } from "./src/schemas/project";
export type { TaskCreateInput, TaskEditInput, TaskSearchInput } from "./src/schemas/task";
export type {
  TaskWithKey,
  TaskPriority,
  Label,
  LabelColor,
  Actor,
  ActorKind,
  Activity,
  ActivityAction,
  Comment,
  CommentWithKey,
} from "./src/types";
export type {
  LabelCreateInput,
  LabelDeleteInput,
  LabelEditInput,
  TaskLabelInput,
} from "./src/schemas/label";
export type { RelationCreateInput, RelationDeleteInput } from "./src/schemas/relation";
export type {
  CommentCreateInput,
  CommentDeleteInput,
  CommentEditInput,
} from "./src/schemas/comment";

export {
  labelCreateSchema,
  labelDeleteSchema,
  labelEditSchema,
  taskLabelSchema,
} from "./src/schemas/label";
export { projectCreateSchema, projectEditSchema } from "./src/schemas/project";
export {
  taskCreateSchema,
  taskEditSchema,
  taskSearchSchema,
  positiveIntegerPattern,
  searchLimitMessage,
} from "./src/schemas/task";
export { relationCreateSchema, relationDeleteSchema } from "./src/schemas/relation";
export { actorSchema } from "./src/schemas/actor";
export { commentCreateSchema, commentDeleteSchema, commentEditSchema } from "./src/schemas/comment";

export const project = {
  getById: dbProject.getById,
  getByKey: dbProject.getByKey,
  create: (input: ProjectCreateInput) => {
    const props = validateProjectInput(projectCreateSchema, input);
    const existingProject = dbProject.getByKey(props.key);

    if (existingProject != null) {
      throw new Error(`Project with key "${existingProject.key}" already exists!`);
    }

    const key = standardizeProjectKey(props.key);
    const project = dbProject.create({ key, name: props.name ?? key })!;

    const defaultColumns = ["Backlog", "TODO", "In Progress", "Review", "Done"];
    let lastColumnOrder: string | null = null;

    for (const col of defaultColumns) {
      const columnOrder = generateKeyBetween(lastColumnOrder, null);
      dbColumn.create({
        id: randomUUIDv7(),
        project_id: project?.id,
        name: col,
        column_order: columnOrder,
      })!;
      lastColumnOrder = columnOrder;
    }

    return project;
  },
  /** Rename a project. Same name does not alter the timestamp */
  edit: (input: ProjectEditInput) => {
    const props = validateProjectInput(projectEditSchema, input);
    const projectMatch = dbProject.getByKey(props.projectKey);

    if (projectMatch == null) {
      throw new Error(
        `Project with key "${standardizeProjectKey(props.projectKey)}" does not exist!`,
      );
    }

    if (props.name === projectMatch.name) {
      return projectMatch;
    }

    return dbProject.update({ id: projectMatch.id, name: props.name, updated_at: Date.now() })!;
  },
  getAll: dbProject.getAll,
  delete: (key: string) => {
    const project = dbProject.getByKey(key);

    if (project == null) {
      throw new Error(`Project with key "${key}" does not exist!`);
    }

    getDb().transaction(() => {
      for (const taskMatch of dbTask.getAllByProjectId(project.id, "all")) {
        dbTask.removeFromSearch(taskMatch.id);
      }

      dbProject.deleteByKey(key);
    })();
    return project;
  },
  standardizeKey: standardizeProjectKey,
};

export const column = {
  getById: dbColumn.getById,
  getAllByProjectKey: (key: string) => {
    const standardizedKey = standardizeProjectKey(key);
    const project = dbProject.getByKey(standardizedKey);

    if (project == null) {
      throw new Error(`Project with key "${key}" does not exist!`);
    }
    return dbColumn.getAllByProjectId(project.id);
  },
  create: (column: Omit<Column, "id" | "project_id" | "column_order"> & { projectKey: string }) => {
    const standardizedKey = standardizeProjectKey(column.projectKey);
    const project = dbProject.getByKey(standardizedKey);

    if (project == null) {
      throw new Error(`Project with key "${standardizedKey}" does not exist!`);
    }

    const allProjectColumns = dbColumn.getAllByProjectId(project.id);
    const existingColumn = allProjectColumns.find(
      (existing) => existing.name.toLowerCase() === column.name.toLowerCase(),
    );

    if (existingColumn != null) {
      throw new Error(`There is already a "${column.name}" column`);
    }

    const lastColOrder = allProjectColumns[allProjectColumns.length - 1]?.column_order ?? null;

    return dbColumn.create({
      id: randomUUIDv7(),
      name: column.name,
      column_order: generateKeyBetween(lastColOrder, null),
      project_id: project.id,
    })!;
  },
};

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

function getTaskByKey(taskKey: string) {
  const parsedKey = parseTaskKey(taskKey);
  if (parsedKey == null) {
    throw new Error(`Invalid task key "${taskKey}". Expected format PROJECT-1`);
  }

  return requireTaskByParsedKey(parsedKey);
}

function findTaskByExactKey(query: string) {
  const parsedKey = parseTaskKey(query.trim());
  if (parsedKey == null) {
    return null;
  }

  return findTaskByParsedKey(parsedKey).task;
}

/** Rewrites a task's search row from its current title, description and comments. */
function updateTaskSearchRecord(taskId: string) {
  dbTask.removeFromSearch(taskId);

  const taskMatch = dbTask.getById(taskId)!;
  const comments = dbComment.getAllByTaskId(taskId).map((commentMatch) => commentMatch.text);
  dbTask.addToSearch({
    taskId,
    title: taskMatch.title,
    description: taskMatch.description,
    comments: comments.join("\n"),
  });
}

function getSearchMatchExpression(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .map((word) => `"${word.replaceAll('"', '""')}"*`)
    .join(" ");
}

type TaskOrderProps =
  | {
      taskKey: string;
      direction: "top" | "up" | "down" | "bottom";
      targetTaskKey?: never;
    }
  | {
      taskKey: string;
      direction: "before" | "after";
      targetTaskKey: string;
    };

function attachTaskKey(task: Task, projectKey?: string): TaskWithKey {
  const key = projectKey ?? dbProject.getById(task.project_id)!.key;
  return { ...task, key: `${key}-${task.number}` };
}

function attachCommentKey(comment: Comment, taskKey: string): CommentWithKey {
  return { ...comment, key: `${taskKey}#${comment.number}` };
}

function getCommentByKey(commentKey: string): CommentWithKey {
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

function resolveLabels(names: Array<string>) {
  const uniqueNames = [...new Set(names)];
  return uniqueNames.map((name) => {
    const match = dbLabel.getByName(name);
    if (match == null) {
      throw new Error(`A label with name "${name}" does not exist`);
    }

    return match;
  });
}

function recordTaskActivity(
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
function describeRelation(
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

export const task = {
  create: (input: TaskCreateInput, actor: Actor) => {
    const task = validateTaskInput(taskCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const labels = resolveLabels(task.labelNames ?? []);
      const project = dbProject.getById(task.project_id);
      const counter = dbProject.incrementTaskCounterById(task.project_id);

      if (project == null || counter == null) {
        throw new Error(
          `Project's next task number could not be retrieved  (ID:${task.project_id})`,
        );
      }

      const initialColumn = dbColumn.getAllByProjectId(task.project_id)[0];
      if (initialColumn == null) {
        throw new Error(`Project "${project.key}" does not have any columns`);
      }

      const lastTask = dbTask.getLastByColumnId(initialColumn.id);
      const order = generateKeyBetween(lastTask?.task_order ?? null, null);

      const now = Date.now();
      const createdTask = dbTask.create({
        id: randomUUIDv7(),
        project_id: task.project_id,
        column_id: initialColumn.id,
        number: counter.task_count,
        title: task.title,
        description: task.description,
        task_order: order,
        priority: task.priority ?? null,
        created_at: now,
        updated_at: now,
      })!;

      for (const label of labels) {
        dbTask.addLabel(createdTask.id, label.id);
      }
      updateTaskSearchRecord(createdTask.id);

      recordTaskActivity(validActor, {
        taskId: createdTask.id,
        action: "create",
        changes: {
          title: createdTask.title,
          description: createdTask.description,
          priority: createdTask.priority,
          column: { id: initialColumn.id, name: initialColumn.name },
          labels: labels.map((label) => label.name),
        },
        createdAt: now,
      });

      return attachTaskKey(createdTask, project.key);
    })();
  },
  getAll: (props: { projectKey?: string; archive?: dbTask.TaskArchiveFilter } = {}) => {
    if (props.projectKey == null) {
      return dbTask.getAll(props.archive).map((task) => attachTaskKey(task));
    }

    const taskProject = dbProject.getByKey(props.projectKey);

    if (taskProject == null) {
      throw new Error(`Project with key "${props.projectKey}" does not exist!`);
    }

    return dbTask
      .getAllByProjectId(taskProject.id, props.archive)
      .map((task) => attachTaskKey(task, taskProject.key));
  },
  getByKey: getTaskByKey,
  search: (input: TaskSearchInput) => {
    const props = validateTaskInput(taskSearchSchema, input);
    const archive = props.archive ?? "active";
    let projectId: string | undefined;

    if (props.projectKey != null) {
      const projectMatch = dbProject.getByKey(props.projectKey);

      if (projectMatch == null) {
        throw new Error(`Project with key "${props.projectKey}" does not exist!`);
      }

      projectId = projectMatch.id;
    }

    const keyMatch = findTaskByExactKey(props.query);
    const isKeyMatchInScope =
      keyMatch != null && (projectId == null || keyMatch.project_id === projectId);
    const pinnedTasks = isKeyMatchInScope ? [keyMatch] : [];

    const textMatches = dbTask
      .search({ match: getSearchMatchExpression(props.query), projectId })
      .filter((row) => !pinnedTasks.some((pinned) => pinned.id === row.id))
      .map(({ project_key, ...row }) => attachTaskKey(row, project_key));

    const matches = [...pinnedTasks, ...textMatches];
    const hiddenArchivedCount =
      archive === "active"
        ? matches.filter((taskMatch) => taskMatch.archived_at != null).length
        : 0;

    return {
      tasks: matches
        .filter((taskMatch) => dbTask.matchesArchiveFilter(taskMatch, archive))
        .slice(0, props.limit),
      hiddenArchivedCount,
    };
  },
  label: {
    getAll: (taskKey: string) => dbTask.getLabels(getTaskByKey(taskKey).id),
    add: (input: TaskLabelInput, actor: Actor): TaskWithKey => {
      const props = validateTaskInput(taskLabelSchema, input);
      return task.edit({ taskKey: props.taskKey, addLabelNames: props.labelNames }, actor);
    },
    remove: (input: TaskLabelInput, actor: Actor): TaskWithKey => {
      const props = validateTaskInput(taskLabelSchema, input);
      return task.edit({ taskKey: props.taskKey, removeLabelNames: props.labelNames }, actor);
    },
  },
  /** Edit supplied content fields, including on archived tasks. Unchanged edits are no-ops. */
  edit: (input: TaskEditInput, actor: Actor) => {
    const props = validateTaskInput(taskEditSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);
    return getDb().transaction(() => {
      const existing = getTaskByKey(props.taskKey);
      const additions = resolveLabels(props.addLabelNames ?? []);
      const removals = resolveLabels(props.removeLabelNames ?? []);
      const existingLabelIds = new Set(dbTask.getLabels(existing.id).map((label) => label.id));
      const labelsToAdd = additions.filter((label) => !existingLabelIds.has(label.id));
      const labelsToRemove = removals.filter((label) => existingLabelIds.has(label.id));
      const areLabelsUnchanged = labelsToAdd.length === 0 && labelsToRemove.length === 0;
      const isTitleUnchanged = props.title === undefined || props.title === existing.title;
      const isDescriptionUnchanged =
        props.description === undefined || props.description === existing.description;

      const isPriorityUnchanged =
        props.priority === undefined || props.priority === existing.priority;

      if (isTitleUnchanged && isDescriptionUnchanged && isPriorityUnchanged && areLabelsUnchanged) {
        return existing;
      }

      for (const label of labelsToAdd) {
        dbTask.addLabel(existing.id, label.id);
      }

      for (const label of labelsToRemove) {
        dbTask.removeLabel(existing.id, label.id);
      }

      const changes: Record<string, unknown> = {};
      if (!isTitleUnchanged) {
        changes.title = [existing.title, props.title];
      }

      if (!isDescriptionUnchanged) {
        changes.description = [existing.description, props.description];
      }

      if (!isPriorityUnchanged) {
        changes.priority = [existing.priority, props.priority];
      }

      if (!areLabelsUnchanged) {
        changes.labels = {
          added: labelsToAdd.map((label) => label.name),
          removed: labelsToRemove.map((label) => label.name),
        };
      }

      const now = Date.now();
      recordTaskActivity(validActor, {
        taskId: existing.id,
        action: "edit",
        changes,
        createdAt: now,
      });

      const editedTask = dbTask.update({
        id: existing.id,
        title: props.title,
        description: props.description,
        priority: props.priority,
        updated_at: now,
      })!;

      updateTaskSearchRecord(existing.id);

      return { ...editedTask, key: existing.key };
    })();
  },
  /**
   * Moves a task to another column in its project.
   *
   * Moving a task to a different column lists it last in that column,
   *  matching placement at the bottom of a visual kanban column.
   * Giving a task's current column as the target will not do anything.
   * Archived tasks must be unarchived before they can be moved.
   */
  move: (props: { taskKey: string; targetColumn: string }, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const taskMatch = getTaskByKey(props.taskKey);

      if (taskMatch.archived_at != null) {
        throw new Error(`Archived task "${props.taskKey}" cannot be moved`);
      }

      const projectColumns = dbColumn.getAllByProjectId(taskMatch.project_id);
      const columnMatch = projectColumns.find(
        (column) => column.name.toLowerCase() === props.targetColumn.toLowerCase(),
      );

      if (columnMatch == null) {
        // TODO: maybe a `did you mean` type of fuzzy check for misspelllings
        const projectMatch = dbProject.getById(taskMatch.project_id)!;
        throw new Error(
          `${projectMatch.name} does not have a column named "${props.targetColumn}"`,
        );
      }

      if (columnMatch.id === taskMatch.column_id) {
        return taskMatch;
      }

      const currentColumn = projectColumns.find((column) => column.id === taskMatch.column_id)!;
      const lastTask = dbTask.getLastByColumnId(columnMatch.id);
      const order = generateKeyBetween(lastTask?.task_order ?? null, null);
      const now = Date.now();

      recordTaskActivity(validActor, {
        taskId: taskMatch.id,
        action: "move",
        changes: {
          column: [
            { id: currentColumn.id, name: currentColumn.name },
            { id: columnMatch.id, name: columnMatch.name },
          ],
        },
        createdAt: now,
      });

      return {
        ...dbTask.update({
          id: taskMatch.id,
          column_id: columnMatch.id,
          task_order: order,
          updated_at: now,
        })!,
        key: taskMatch.key,
      };
    })();
  },
  order: (props: TaskOrderProps, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);
    const { taskKey, direction } = props;

    return getDb().transaction(() => {
      const taskMatch = getTaskByKey(taskKey);

      if (taskMatch.archived_at != null) {
        throw new Error(`Archived task "${taskKey}" cannot be reordered`);
      }

      const allTasks = dbTask.getAllByColumnId(taskMatch.column_id);
      const taskIndex = allTasks.findIndex((candidate) => candidate.id === taskMatch.id);
      const otherTasks = allTasks.filter((candidate) => candidate.id !== taskMatch.id);
      let insertionIndex: number;

      switch (direction) {
        case "top":
          insertionIndex = 0;
          break;
        case "up":
          insertionIndex = Math.max(0, taskIndex - 1);
          break;
        case "down":
          insertionIndex = Math.min(otherTasks.length, taskIndex + 1);
          break;
        case "bottom":
          insertionIndex = otherTasks.length;
          break;
        case "before":
        case "after": {
          const targetTask = getTaskByKey(props.targetTaskKey);

          if (targetTask.id === taskMatch.id) {
            return taskMatch;
          }

          if (targetTask.project_id !== taskMatch.project_id) {
            throw new Error(
              `Tasks "${taskKey}" and "${props.targetTaskKey}" must be in the same project`,
            );
          }

          if (targetTask.column_id !== taskMatch.column_id) {
            throw new Error(
              `Tasks "${taskKey}" and "${props.targetTaskKey}" must be in the same column`,
            );
          }

          if (targetTask.archived_at != null) {
            throw new Error(`Archived task "${props.targetTaskKey}" cannot be an ordering target`);
          }

          const targetIndex = otherTasks.findIndex((candidate) => candidate.id === targetTask.id);
          insertionIndex = direction === "before" ? targetIndex : targetIndex + 1;
          break;
        }
      }

      if (insertionIndex === taskIndex) {
        return taskMatch;
      }

      const futurePrevTask = otherTasks[insertionIndex - 1] ?? null;
      const futureNextTask = otherTasks[insertionIndex] ?? null;
      const now = Date.now();

      recordTaskActivity(validActor, {
        taskId: taskMatch.id,
        action: "order",
        changes: null,
        createdAt: now,
      });

      return {
        ...dbTask.update({
          id: taskMatch.id,
          task_order: generateKeyBetween(
            futurePrevTask?.task_order ?? null,
            futureNextTask?.task_order ?? null,
          ),
          updated_at: now,
        })!,
        key: taskMatch.key,
      };
    })();
  },
  /**
   * Deletes a task. Its activity rows remain.
   * Tasks on the other side of its relations get a relation_delete row,
   *  since the cascade removes those relations too.
   */
  delete: (taskKey: string, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const taskMatch = getTaskByKey(taskKey);
      const now = Date.now();

      for (const relationMatch of dbRelation.getAllByTaskId(taskMatch.id)) {
        const otherTaskId =
          relationMatch.source_task_id === taskMatch.id
            ? relationMatch.target_task_id
            : relationMatch.source_task_id;

        recordTaskActivity(validActor, {
          taskId: otherTaskId,
          action: "relation_delete",
          changes: describeRelation(relationMatch),
          createdAt: now,
        });
      }

      recordTaskActivity(validActor, {
        taskId: taskMatch.id,
        action: "delete",
        changes: { key: taskMatch.key, title: taskMatch.title },
        createdAt: now,
      });

      dbTask.removeFromSearch(taskMatch.id);
      dbTask.deleteById(taskMatch.id);
      return taskMatch;
    })();
  },
  archive: (taskKey: string, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const taskMatch = getTaskByKey(taskKey);

      if (taskMatch.archived_at != null) {
        return taskMatch;
      }

      const now = Date.now();
      recordTaskActivity(validActor, {
        taskId: taskMatch.id,
        action: "archive",
        changes: null,
        createdAt: now,
      });

      return {
        ...dbTask.update({ id: taskMatch.id, updated_at: now, archived_at: now })!,
        key: taskMatch.key,
      };
    })();
  },
  unarchive: (taskKey: string, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const taskMatch = getTaskByKey(taskKey);

      if (taskMatch.archived_at == null) {
        return taskMatch;
      }

      const lastTask = dbTask.getLastByColumnId(taskMatch.column_id);
      const order = generateKeyBetween(lastTask?.task_order ?? null, null);
      const now = Date.now();

      recordTaskActivity(validActor, {
        taskId: taskMatch.id,
        action: "unarchive",
        changes: null,
        createdAt: now,
      });

      return {
        ...dbTask.update({
          id: taskMatch.id,
          task_order: order,
          updated_at: now,
          archived_at: null,
        })!,
        key: taskMatch.key,
      };
    })();
  },
  /** Activity rows recorded for a task, oldest first. */
  activity: (taskKey: string) => dbActivity.getAllByEntityId(getTaskByKey(taskKey).id),
};

function describeComment(comment: CommentWithKey) {
  return { id: comment.id, key: comment.key, text: comment.text };
}

export const comment = {
  getByKey: getCommentByKey,
  getAll: (taskKey: string) => {
    const taskMatch = getTaskByKey(taskKey);
    return dbComment
      .getAllByTaskId(taskMatch.id)
      .map((commentMatch) => attachCommentKey(commentMatch, taskMatch.key));
  },
  create: (input: CommentCreateInput, actor: Actor) => {
    const props = validateTaskInput(commentCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const taskMatch = getTaskByKey(props.taskKey);
      const counter = dbTask.incrementCommentCounterById(taskMatch.id);

      if (counter == null) {
        throw new Error(`Task comment number could not be retrieved for "${taskMatch.key}"`);
      }

      const createdComment = attachCommentKey(
        dbComment.create({
          task_id: taskMatch.id,
          number: counter.comment_count,
          text: props.text,
        })!,
        taskMatch.key,
      );
      updateTaskSearchRecord(taskMatch.id);

      recordTaskActivity(validActor, {
        taskId: taskMatch.id,
        action: "comment_create",
        changes: { comment: describeComment(createdComment) },
        createdAt: createdComment.created_at,
      });

      return createdComment;
    })();
  },
  edit: (input: CommentEditInput, actor: Actor) => {
    const props = validateTaskInput(commentEditSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const existing = getCommentByKey(props.commentKey);

      if (existing.text === props.text) {
        return existing;
      }

      const now = Date.now();
      const editedComment = {
        ...dbComment.update({ id: existing.id, text: props.text, updated_at: now })!,
        key: existing.key,
      };
      updateTaskSearchRecord(existing.task_id);

      recordTaskActivity(validActor, {
        taskId: existing.task_id,
        action: "comment_edit",
        changes: {
          comment: { id: existing.id, key: existing.key },
          text: [existing.text, editedComment.text],
        },
        createdAt: now,
      });

      return editedComment;
    })();
  },
  delete: (input: CommentDeleteInput, actor: Actor) => {
    const props = validateTaskInput(commentDeleteSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const existing = getCommentByKey(props.commentKey);
      const now = Date.now();

      recordTaskActivity(validActor, {
        taskId: existing.task_id,
        action: "comment_delete",
        changes: { comment: describeComment(existing) },
        createdAt: now,
      });
      dbComment.deleteById(existing.id);
      updateTaskSearchRecord(existing.task_id);

      return existing;
    })();
  },
};

type RelationResult = TaskRelation & {
  source?: TaskWithKey;
  target?: TaskWithKey;
};

type RelationGetOptions = {
  include?: { tasks?: boolean };
};

function getRelations(taskKey: string, options?: RelationGetOptions): Array<RelationResult> {
  if (taskKey == null) {
    throw new Error("A task key is required to list relations");
  }

  const taskMatch = getTaskByKey(taskKey);
  const relations = dbRelation.getAllByTaskId(taskMatch.id);
  if (!options?.include?.tasks) {
    return relations;
  }

  return relations.map((entry) => ({
    ...entry,
    source: attachTaskKey(dbTask.getById(entry.source_task_id)!),
    target: attachTaskKey(dbTask.getById(entry.target_task_id)!),
  }));
}

function resolveRelationTaskIds(props: RelationCreateInput) {
  const sourceTask = getTaskByKey(props.sourceTaskKey);
  const targetTask = getTaskByKey(props.targetTaskKey);

  if (sourceTask.id === targetTask.id) {
    throw new Error("A task cannot have a relation to itself. Not appropriate.");
  }

  let sourceId = sourceTask.id;
  let targetId = targetTask.id;

  /**
   * To avoid headaches with relations that
   *  technically have no semantic source/target
   *  it felt reasonable to invent reliable "source" and "target"
   *  by enforcing the placements through ID comparison
   */
  const isSymmetricRelation = props.relation_type === "related";
  if (isSymmetricRelation && sourceId > targetId) {
    sourceId = targetTask.id;
    targetId = sourceTask.id;
  }

  return { source_task_id: sourceId, target_task_id: targetId, relation_type: props.relation_type };
}

export const relation = {
  /** Records the same relation_create row on both tasks. */
  create: (input: RelationCreateInput, actor: Actor) => {
    const props = validateTaskInput(relationCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const resolved = resolveRelationTaskIds(props);
      const relationMatch = dbRelation.getByTaskIdsAndType(resolved);

      if (relationMatch != null) {
        throw new Error("This relation already exists");
      }

      const createdRelation = dbRelation.create(resolved)!;
      const changes = describeRelation(createdRelation);

      for (const taskId of [createdRelation.source_task_id, createdRelation.target_task_id]) {
        recordTaskActivity(validActor, {
          taskId,
          action: "relation_create",
          changes,
          createdAt: createdRelation.created_at,
        });
      }

      return createdRelation;
    })();
  },
  /** Records the same relation_delete row on both tasks. */
  delete: (input: RelationDeleteInput, actor: Actor) => {
    const props = validateTaskInput(relationDeleteSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const resolved = resolveRelationTaskIds(props);
      const relationMatch = dbRelation.getByTaskIdsAndType(resolved);

      if (relationMatch == null) {
        throw new Error("This relation does not exist");
      }

      const changes = describeRelation(relationMatch);
      const now = Date.now();

      for (const taskId of [relationMatch.source_task_id, relationMatch.target_task_id]) {
        recordTaskActivity(validActor, {
          taskId,
          action: "relation_delete",
          changes,
          createdAt: now,
        });
      }

      dbRelation.deleteById(relationMatch.id);
      return relationMatch;
    })();
  },
  getAll: getRelations,
};

export const label = {
  create: (input: LabelCreateInput) => {
    const props = validateTaskInput(labelCreateSchema, input);

    if (dbLabel.getByName(props.name) != null) {
      throw new Error(`A label with name "${props.name}" already exists`);
    }

    return dbLabel.create({
      name: props.name,
      description: props.description ?? "",
      color: props.color ?? "white",
    })!;
  },
  /** Editing a global definition preserves attachments and does not edit attached tasks. */
  edit: (input: LabelEditInput) => {
    const props = validateTaskInput(labelEditSchema, input);

    return getDb().transaction(() => {
      const match = resolveLabels([props.labelName])[0]!;
      const name = props.name ?? match.name;
      const description = props.description ?? match.description;
      const color = props.color ?? match.color;

      const isUnchanged =
        name === match.name && description === match.description && color === match.color;
      if (isUnchanged) {
        return match;
      }

      const existingLabel = dbLabel.getByName(name);
      if (existingLabel != null && existingLabel.id !== match.id) {
        throw new Error(`A label with name "${name}" already exists`);
      }

      return dbLabel.update({ id: match.id, name, description, color })!;
    })();
  },
  getAll: dbLabel.getAll,
  getByName: (name: string) => {
    const props = validateTaskInput(labelDeleteSchema, { name });
    return dbLabel.getByName(props.name);
  },
  /** Deleting a definition detaches it from tasks, so each affected task gets an edit row. */
  delete: (input: LabelDeleteInput, actor: Actor) => {
    const props = validateTaskInput(labelDeleteSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const match = resolveLabels([props.name])[0]!;
      const now = Date.now();

      for (const taskId of dbTask.getIdsByLabelId(match.id)) {
        recordTaskActivity(validActor, {
          taskId,
          action: "edit",
          changes: { labels: { added: [], removed: [match.name] } },
          createdAt: now,
        });
      }

      dbTask.updateLabelTasksTimestamp(match.id, now);
      dbLabel.deleteById(match.id);
      return match;
    })();
  },
};
