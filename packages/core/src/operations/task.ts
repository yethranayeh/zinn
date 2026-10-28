import type { Task, TaskChange, TaskWithKey } from "../types.js";
import type {
  TaskCreateInput,
  TaskEditInput,
  TaskListInput,
  TaskSearchInput,
  TaskOrderManyInput,
} from "../schemas/task.js";
import type { TaskLabelInput } from "../schemas/label.js";
import type { Actor } from "../schemas/actor.js";
import type { OrderPlacement } from "./shared.js";

import { v7 as uuidv7 } from "uuid";
import { generateKeyBetween } from "fractional-indexing";

import { CoreError } from "../errors.js";
import { writeTransaction } from "../db.js";
import { rethrowSearchError } from "../search-error.js";
import { taskLabelSchema } from "../schemas/label.js";

import * as dbProject from "../db/project.js";
import * as dbColumn from "../db/column.js";
import * as dbTask from "../db/task.js";
import * as dbTaskLabel from "../db/task-label.js";
import * as dbSearch from "../db/search.js";
import * as dbRelation from "../db/relation.js";
import * as dbActivity from "../db/activity.js";

import {
  validateTaskInput,
  taskCreateSchema,
  taskEditSchema,
  taskListSchema,
  taskSearchSchema,
  taskOrderManySchema,
  taskDeleteManySchema,
} from "../schemas/task.js";
import { actorSchema } from "../schemas/actor.js";

import { relation } from "./relation.js";
import {
  getTaskByKey,
  findTaskByExactKey,
  attachTaskKey,
  getTaskLastActivityTimes,
  resolveLabels,
  recordTaskActivity,
  updateTaskSearchRecord,
  describeRelation,
  getInsertionIndex,
  requireColumnByName,
  findByName,
  resolveDescription,
} from "./shared.js";

function getSearchMatchExpression(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .map((word) => `"${word.replaceAll('"', '""')}"*`)
    .join(" ");
}

function filterTasksByLabels<T extends Pick<Task, "id">>(
  tasks: Array<T>,
  labelNames: Array<string> = [],
) {
  if (labelNames.length === 0) {
    return tasks;
  }

  const labels = resolveLabels(labelNames);
  const taskIdsByLabel = labels.map(
    (labelMatch) => new Set(dbTaskLabel.getTaskIdsByLabelId(labelMatch.id)),
  );

  return tasks.filter((taskMatch) => taskIdsByLabel.every((taskIds) => taskIds.has(taskMatch.id)));
}

function filterTasksByColumn(tasks: Array<Task>, columnName?: string) {
  if (columnName === undefined) {
    return tasks;
  }

  const projectIds = new Set(tasks.map((taskMatch) => taskMatch.project_id));
  const matchingColumnIds = new Set<string>();

  for (const projectId of projectIds) {
    const columnMatch = findByName(dbColumn.getAllByProjectId(projectId), columnName);
    if (columnMatch !== undefined) {
      matchingColumnIds.add(columnMatch.id);
    }
  }

  return tasks.filter((taskMatch) => matchingColumnIds.has(taskMatch.column_id));
}

function filterTasksByDeadline<T extends Pick<Task, "due_at">>(
  tasks: Array<T>,
  bounds: { dueSince?: number; dueUntil?: number },
) {
  if (bounds.dueSince === undefined && bounds.dueUntil === undefined) {
    return tasks;
  }

  return tasks.filter((taskMatch) => {
    const deadline = taskMatch.due_at;
    return (
      deadline !== null &&
      (bounds.dueSince === undefined || deadline >= bounds.dueSince) &&
      (bounds.dueUntil === undefined || deadline <= bounds.dueUntil)
    );
  });
}

type NewTaskRelation = NonNullable<TaskCreateInput["relations"]>[number];

/** Deduplicates identical requests and rejects different types for one resolved target. */
function uniqueRelationRequests(requests: Array<NewTaskRelation>) {
  const uniqueRequests = new Map<string, NewTaskRelation>();

  for (const request of requests) {
    const target = getTaskByKey(request.targetTaskKey);
    const previous = uniqueRequests.get(target.id);

    if (previous !== undefined && previous.relation_type !== request.relation_type) {
      throw new CoreError(`Conflicting relation types for task "${target.key}"`, "input", {
        entity: "relation",
        key: target.key,
        field: ["relations"],
      });
    }
    uniqueRequests.set(target.id, request);
  }

  return [...uniqueRequests.values()];
}

type TaskOrderProps =
  | {
      taskKey: string;
      // TODO: maybe consider replacing with neutral words too?
      direction: "top" | "up" | "down" | "bottom";
      targetTaskKey?: never;
    }
  | {
      taskKey: string;
      direction: "before" | "after";
      targetTaskKey: string;
    };

const neutralTaskDirections = {
  top: "first",
  up: "previous",
  down: "next",
  bottom: "last",
} as const;

function orderTask(props: TaskOrderProps, actor: Actor): TaskChange {
  const { taskKey, direction } = props;
  const taskMatch = getTaskByKey(taskKey);

  if (taskMatch.archived_at != null) {
    throw new CoreError(`Archived task "${taskKey}" cannot be reordered`, "conflict", {
      entity: "task",
      key: taskMatch.key,
      reason: "archived",
    });
  }

  const allTasks = dbTask.getAllByColumnId(taskMatch.column_id);
  const taskIndex = allTasks.findIndex((candidate) => candidate.id === taskMatch.id);
  const otherTasks = allTasks.filter((candidate) => candidate.id !== taskMatch.id);
  let placement: OrderPlacement;

  switch (direction) {
    case "top":
    case "up":
    case "down":
    case "bottom":
      placement = { direction: neutralTaskDirections[direction] };
      break;
    case "before":
    case "after": {
      const targetTask = getTaskByKey(props.targetTaskKey);

      if (targetTask.id === taskMatch.id) {
        return { task: taskMatch, changed: false };
      }

      if (targetTask.project_id !== taskMatch.project_id) {
        throw new CoreError(
          `Tasks "${taskKey}" and "${props.targetTaskKey}" must be in the same project`,
          "conflict",
          { entity: "task", key: taskMatch.key, reason: "different_project" },
        );
      }

      if (targetTask.column_id !== taskMatch.column_id) {
        throw new CoreError(
          `Tasks "${taskKey}" and "${props.targetTaskKey}" must be in the same column`,
          "conflict",
          { entity: "task", key: taskMatch.key, reason: "different_column" },
        );
      }

      if (targetTask.archived_at != null) {
        throw new CoreError(
          `Archived task "${props.targetTaskKey}" cannot be an ordering target`,
          "conflict",
          { entity: "task", key: targetTask.key, reason: "archived" },
        );
      }

      const targetIndex = allTasks.findIndex((candidate) => candidate.id === targetTask.id);
      placement = { direction, targetIndex };
      break;
    }
  }

  const insertionIndex = getInsertionIndex(allTasks.length, taskIndex, placement);

  if (insertionIndex === taskIndex) {
    return { task: taskMatch, changed: false };
  }

  const futurePrevTask = otherTasks[insertionIndex - 1] ?? null;
  const futureNextTask = otherTasks[insertionIndex] ?? null;
  const now = Date.now();

  recordTaskActivity(actor, {
    taskId: taskMatch.id,
    action: "order",
    changes: null,
    createdAt: now,
  });

  return {
    task: {
      ...dbTask.update({
        id: taskMatch.id,
        task_order: generateKeyBetween(
          futurePrevTask?.task_order ?? null,
          futureNextTask?.task_order ?? null,
        ),
        updated_at: now,
      })!,
      key: taskMatch.key,
    },
    changed: true,
  };
}

function moveTask(props: { taskKey: string; targetColumn: string }, actor: Actor): TaskChange {
  const taskMatch = getTaskByKey(props.taskKey);

  if (taskMatch.archived_at != null) {
    throw new CoreError(`Archived task "${props.taskKey}" cannot be moved`, "conflict", {
      entity: "task",
      key: taskMatch.key,
      reason: "archived",
    });
  }

  const projectMatch = dbProject.getById(taskMatch.project_id)!;
  const projectColumns = dbColumn.getAllByProjectId(taskMatch.project_id);
  const { columnMatch } = requireColumnByName(projectMatch, projectColumns, props.targetColumn);

  if (columnMatch.id === taskMatch.column_id) {
    return { task: taskMatch, changed: false };
  }

  const currentColumn = projectColumns.find((column) => column.id === taskMatch.column_id)!;
  const lastTask = dbTask.getLastByColumnId(columnMatch.id);
  const order = generateKeyBetween(lastTask?.task_order ?? null, null);
  const now = Date.now();

  recordTaskActivity(actor, {
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

  const movedTask = dbTask.update({
    id: taskMatch.id,
    column_id: columnMatch.id,
    task_order: order,
    updated_at: now,
  })!;

  return { task: { ...movedTask, key: taskMatch.key }, changed: true };
}

function archiveTask(taskKey: string, actor: Actor): TaskChange {
  const taskMatch = getTaskByKey(taskKey);

  if (taskMatch.archived_at != null) {
    return { task: taskMatch, changed: false };
  }

  const now = Date.now();
  recordTaskActivity(actor, {
    taskId: taskMatch.id,
    action: "archive",
    changes: null,
    createdAt: now,
  });

  const archivedTask = dbTask.update({ id: taskMatch.id, updated_at: now, archived_at: now })!;

  return { task: { ...archivedTask, key: taskMatch.key }, changed: true };
}

function unarchiveTask(taskKey: string, actor: Actor): TaskChange {
  const taskMatch = getTaskByKey(taskKey);

  if (taskMatch.archived_at == null) {
    return { task: taskMatch, changed: false };
  }

  const lastTask = dbTask.getLastByColumnId(taskMatch.column_id);
  const order = generateKeyBetween(lastTask?.task_order ?? null, null);
  const now = Date.now();

  recordTaskActivity(actor, {
    taskId: taskMatch.id,
    action: "unarchive",
    changes: null,
    createdAt: now,
  });

  const unarchivedTask = dbTask.update({
    id: taskMatch.id,
    task_order: order,
    updated_at: now,
    archived_at: null,
  })!;

  return { task: { ...unarchivedTask, key: taskMatch.key }, changed: true };
}

export const task = {
  create: (input: TaskCreateInput, actor: Actor) => {
    const task = validateTaskInput(taskCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const labels = resolveLabels(task.labelNames ?? []);
      const project = dbProject.getById(task.project_id);
      const counter = dbProject.incrementTaskCounterById(task.project_id);

      if (project == null) {
        throw new CoreError(
          `Project's next task number could not be retrieved  (ID:${task.project_id})`,
          "missing",
          { entity: "project", key: task.project_id },
        );
      }

      if (counter == null) {
        throw new Error(
          `Project's next task number could not be retrieved  (ID:${task.project_id})`,
        );
      }

      const projectColumns = dbColumn.getAllByProjectId(task.project_id);
      if (projectColumns.length === 0) {
        throw new CoreError(`Project "${project.key}" does not have any columns`, "conflict", {
          entity: "project",
          key: project.key,
          reason: "no_columns",
        });
      }

      const initialColumn =
        task.columnName === undefined
          ? projectColumns[0]!
          : requireColumnByName(project, projectColumns, task.columnName).columnMatch;

      const lastTask = dbTask.getLastByColumnId(initialColumn.id);
      const order = generateKeyBetween(lastTask?.task_order ?? null, null);

      const now = Date.now();
      const createdTask = dbTask.create({
        id: uuidv7(),
        project_id: task.project_id,
        column_id: initialColumn.id,
        number: counter.task_count,
        title: task.title,
        description: task.description,
        task_order: order,
        priority: task.priority ?? null,
        due_at: task.due_at ?? null,
        created_at: now,
        updated_at: now,
      })!;

      for (const label of labels) {
        dbTaskLabel.create(createdTask.id, label.id);
      }
      updateTaskSearchRecord(createdTask.id);

      recordTaskActivity(validActor, {
        taskId: createdTask.id,
        action: "create",
        changes: {
          title: createdTask.title,
          description: createdTask.description,
          priority: createdTask.priority,
          due_at: createdTask.due_at,
          column: { id: initialColumn.id, name: initialColumn.name },
          labels: labels.map((label) => label.name),
        },
        createdAt: now,
      });

      const createdTaskWithKey = attachTaskKey(createdTask, project.key);

      for (const request of uniqueRelationRequests(task.relations ?? [])) {
        relation.create({ sourceTaskKey: createdTaskWithKey.key, ...request }, validActor);
      }

      return createdTaskWithKey;
    });
  },
  getAll: (input: TaskListInput = {}) => {
    const props = validateTaskInput(taskListSchema, input);
    const taskProject = props.projectKey == null ? null : dbProject.getByKey(props.projectKey);

    if (props.projectKey != null && taskProject == null) {
      throw new CoreError(`Project with key "${props.projectKey}" does not exist`, "missing", {
        entity: "project",
        key: props.projectKey,
      });
    }

    const taskMatches = filterTasksByLabels(
      taskProject == null
        ? dbTask.getAll(props.archive)
        : dbTask.getAllByProjectId(taskProject.id, props.archive),
      props.labelNames,
    );
    const filteredTasks = filterTasksByDeadline(
      filterTasksByColumn(taskMatches, props.columnName),
      props,
    );

    if (props.sort === "activity") {
      const lastActivityTimes = getTaskLastActivityTimes(filteredTasks);
      filteredTasks.sort(
        (left, right) => lastActivityTimes.get(right.id)! - lastActivityTimes.get(left.id)!,
      );
    } else if (props.sort === "due") {
      filteredTasks.sort((left, right) => {
        if (left.due_at === null) {
          return right.due_at === null ? 0 : 1;
        }

        if (right.due_at === null) {
          return -1;
        }

        return left.due_at - right.due_at;
      });
    }

    return filteredTasks
      .slice(0, props.limit)
      .map((taskMatch) => attachTaskKey(taskMatch, taskProject?.key));
  },
  getByKey: getTaskByKey,
  search: (input: TaskSearchInput) => {
    const props = validateTaskInput(taskSearchSchema, input);
    const archive = props.archive ?? "active";
    let projectId: string | undefined;

    if (props.projectKey != null) {
      const projectMatch = dbProject.getByKey(props.projectKey);

      if (projectMatch == null) {
        throw new CoreError(`Project with key "${props.projectKey}" does not exist`, "missing", {
          entity: "project",
          key: props.projectKey,
        });
      }

      projectId = projectMatch.id;
    }

    const keyMatch = findTaskByExactKey(props.query);
    const isKeyMatchInScope =
      keyMatch != null && (projectId == null || keyMatch.project_id === projectId);
    const pinnedTasks = isKeyMatchInScope ? [keyMatch] : [];

    let searchRows;
    try {
      searchRows = dbSearch.searchTasks({
        match: getSearchMatchExpression(props.query),
        projectId,
      });
    } catch (error) {
      rethrowSearchError(error);
    }
    const textMatches = searchRows
      .filter((row) => !pinnedTasks.some((pinned) => pinned.id === row.id))
      .map(({ project_key, ...row }) => attachTaskKey(row, project_key));

    const matches = filterTasksByDeadline(
      filterTasksByLabels([...pinnedTasks, ...textMatches], props.labelNames),
      props,
    );
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
    getAll: (taskKey: string) => dbTaskLabel.getAllByTaskId(getTaskByKey(taskKey).id),
    add: (input: TaskLabelInput, actor: Actor): TaskChange => {
      const props = validateTaskInput(taskLabelSchema, input);
      return task.edit({ taskKey: props.taskKey, addLabelNames: props.labelNames }, actor);
    },
    remove: (input: TaskLabelInput, actor: Actor): TaskChange => {
      const props = validateTaskInput(taskLabelSchema, input);
      return task.edit({ taskKey: props.taskKey, removeLabelNames: props.labelNames }, actor);
    },
  },
  /** Edit task content and label attachments, including on archived tasks. */
  edit: (input: TaskEditInput, actor: Actor): TaskChange => {
    const props = validateTaskInput(taskEditSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const existing = getTaskByKey(props.taskKey);
      const additions = resolveLabels(props.addLabelNames ?? []);
      const removals = resolveLabels(props.removeLabelNames ?? []);
      const existingLabelIds = new Set(
        dbTaskLabel.getAllByTaskId(existing.id).map((label) => label.id),
      );
      const labelsToAdd = additions.filter((label) => !existingLabelIds.has(label.id));
      const labelsToRemove = removals.filter((label) => existingLabelIds.has(label.id));
      const areLabelsUnchanged = labelsToAdd.length === 0 && labelsToRemove.length === 0;
      const isTitleUnchanged = props.title === undefined || props.title === existing.title;
      const description =
        props.description === undefined
          ? undefined
          : resolveDescription(
              props.description,
              existing.description,
              `${existing.key}'s description`,
            );
      const isDescriptionUnchanged =
        description === undefined || description === existing.description;

      const isPriorityUnchanged =
        props.priority === undefined || props.priority === existing.priority;
      const isDeadlineUnchanged = props.due_at === undefined || props.due_at === existing.due_at;

      const isTaskUnchanged =
        isTitleUnchanged &&
        isDescriptionUnchanged &&
        isPriorityUnchanged &&
        isDeadlineUnchanged &&
        areLabelsUnchanged;
      if (isTaskUnchanged) {
        return { task: existing, changed: false };
      }

      for (const label of labelsToAdd) {
        dbTaskLabel.create(existing.id, label.id);
      }

      for (const label of labelsToRemove) {
        dbTaskLabel.deleteByIds(existing.id, label.id);
      }

      const changes: Record<string, unknown> = {};
      if (!isTitleUnchanged) {
        changes.title = [existing.title, props.title];
      }

      if (!isDescriptionUnchanged) {
        changes.description = [existing.description, description];
      }

      if (!isPriorityUnchanged) {
        changes.priority = [existing.priority, props.priority];
      }

      if (!isDeadlineUnchanged) {
        changes.due_at = [existing.due_at, props.due_at];
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
        description,
        priority: props.priority,
        due_at: props.due_at,
        updated_at: now,
      })!;

      updateTaskSearchRecord(existing.id);

      return { task: { ...editedTask, key: existing.key }, changed: true };
    });
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

    return writeTransaction(() => moveTask(props, validActor).task);
  },
  moveMany: (
    props: { taskKeys: Array<string>; targetColumn: string },
    actor: Actor,
  ): Array<TaskChange> => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() =>
      props.taskKeys.map((taskKey) =>
        moveTask({ taskKey, targetColumn: props.targetColumn }, validActor),
      ),
    );
  },
  order: (props: TaskOrderProps, actor: Actor): TaskChange => {
    const validActor = validateTaskInput(actorSchema, actor);
    return writeTransaction(() => orderTask(props, validActor));
  },
  orderMany: (input: TaskOrderManyInput, actor: Actor): Array<TaskChange> => {
    const props = validateTaskInput(taskOrderManySchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const isBatch = props.taskKeys.length > 1;
      const isStepDirection = props.direction === "up" || props.direction === "down";

      if (isBatch && isStepDirection) {
        throw new CoreError("Up and down require exactly one task key", "input", {
          field: ["direction"],
        });
      }

      const tasks = props.taskKeys.map(getTaskByKey);
      const first = tasks[0]!;
      const seen = new Set<string>();

      for (const match of tasks) {
        if (seen.has(match.id)) {
          throw new CoreError(`Task "${match.key}" is listed more than once`, "input", {
            entity: "task",
            key: match.key,
            field: ["taskKeys"],
          });
        }

        seen.add(match.id);
        if (match.project_id !== first.project_id) {
          throw new CoreError("Ordered tasks must be in the same project", "conflict", {
            entity: "task",
            key: match.key,
            reason: "different_project",
          });
        }

        if (match.column_id !== first.column_id) {
          throw new CoreError("Ordered tasks must be in the same column", "conflict", {
            entity: "task",
            key: match.key,
            reason: "different_column",
          });
        }
      }

      const targetsListedTask =
        isBatch &&
        "targetTaskKey" in props &&
        tasks.some((match) => match.key === props.targetTaskKey.toUpperCase());

      if (targetsListedTask) {
        throw new CoreError("The ordering target cannot be one of the listed tasks", "input", {
          entity: "task",
          key: props.targetTaskKey,
          field: ["targetTaskKey"],
        });
      }

      return props.taskKeys.map((taskKey, index) => {
        const placement: TaskOrderProps =
          index === 0
            ? { ...props, taskKey }
            : { taskKey, direction: "after", targetTaskKey: props.taskKeys[index - 1]! };
        return orderTask(placement, validActor);
      });
    });
  },
  /**
   * Deletes a task. Its activity rows remain.
   * Tasks on the other side of its relations get a relation_delete row,
   *  since the cascade removes those relations too.
   */
  delete: (taskKey: string, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
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

      dbSearch.removeTask(taskMatch.id);
      dbTask.deleteById(taskMatch.id);
      return taskMatch;
    });
  },
  deleteMany: (taskKeys: Array<string>, actor: Actor): Array<TaskWithKey> => {
    const validTaskKeys = validateTaskInput(taskDeleteManySchema, taskKeys);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => validTaskKeys.map((taskKey) => task.delete(taskKey, validActor)));
  },
  archive: (taskKey: string, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => archiveTask(taskKey, validActor).task);
  },
  archiveMany: (taskKeys: Array<string>, actor: Actor): Array<TaskChange> => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => taskKeys.map((taskKey) => archiveTask(taskKey, validActor)));
  },
  unarchive: (taskKey: string, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => unarchiveTask(taskKey, validActor).task);
  },
  unarchiveMany: (taskKeys: Array<string>, actor: Actor): Array<TaskChange> => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => taskKeys.map((taskKey) => unarchiveTask(taskKey, validActor)));
  },
  activity: (taskKey: string) => dbActivity.getAllByEntity("task", getTaskByKey(taskKey).id),
};
