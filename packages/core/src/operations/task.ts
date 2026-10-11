import type { Task, TaskChange, TaskWithKey } from "../types";
import type {
  TaskCreateInput,
  TaskEditInput,
  TaskListInput,
  TaskSearchInput,
} from "../schemas/task";
import type { TaskLabelInput } from "../schemas/label";
import type { Actor } from "../schemas/actor";
import type { OrderPlacement } from "./shared";

import { v7 as uuidv7 } from "uuid";
import { generateKeyBetween } from "fractional-indexing";

import { writeTransaction } from "../db";
import { taskLabelSchema } from "../schemas/label";

import * as dbProject from "../db/project";
import * as dbColumn from "../db/column";
import * as dbTask from "../db/task";
import * as dbTaskLabel from "../db/task-label";
import * as dbSearch from "../db/search";
import * as dbRelation from "../db/relation";
import * as dbActivity from "../db/activity";

import {
  validateTaskInput,
  taskCreateSchema,
  taskEditSchema,
  taskListSchema,
  taskSearchSchema,
} from "../schemas/task";
import { actorSchema } from "../schemas/actor";

import { relation } from "./relation";
import {
  getTaskByKey,
  findTaskByExactKey,
  attachTaskKey,
  resolveLabels,
  recordTaskActivity,
  updateTaskSearchRecord,
  describeRelation,
  getInsertionIndex,
  requireColumnByName,
  findByName,
  resolveDescription,
} from "./shared";

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

type NewTaskRelation = NonNullable<TaskCreateInput["relations"]>[number];

/** Keeps one request per relation type and target task, so a repeated target counts once. */
function uniqueRelationRequests(requests: Array<NewTaskRelation>) {
  const uniqueRequests = new Map<string, NewTaskRelation>();

  for (const request of requests) {
    const target = getTaskByKey(request.targetTaskKey);
    uniqueRequests.set(`${request.relation_type}:${target.id}`, request);
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

function moveTask(props: { taskKey: string; targetColumn: string }, actor: Actor): TaskChange {
  const taskMatch = getTaskByKey(props.taskKey);

  if (taskMatch.archived_at != null) {
    throw new Error(`Archived task "${props.taskKey}" cannot be moved`);
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

      if (project == null || counter == null) {
        throw new Error(
          `Project's next task number could not be retrieved  (ID:${task.project_id})`,
        );
      }

      const projectColumns = dbColumn.getAllByProjectId(task.project_id);
      const initialColumn =
        task.columnName === undefined
          ? projectColumns[0]
          : requireColumnByName(project, projectColumns, task.columnName).columnMatch;
      if (initialColumn == null) {
        throw new Error(`Project "${project.key}" does not have any columns`);
      }

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

    if (props.projectKey == null) {
      const taskMatches = filterTasksByLabels(dbTask.getAll(props.archive), props.labelNames);
      return filterTasksByColumn(taskMatches, props.columnName).map((taskMatch) =>
        attachTaskKey(taskMatch),
      );
    }

    const taskProject = dbProject.getByKey(props.projectKey);

    if (taskProject == null) {
      throw new Error(`Project with key "${props.projectKey}" does not exist!`);
    }

    const taskMatches = filterTasksByLabels(
      dbTask.getAllByProjectId(taskProject.id, props.archive),
      props.labelNames,
    );
    return filterTasksByColumn(taskMatches, props.columnName).map((taskMatch) =>
      attachTaskKey(taskMatch, taskProject.key),
    );
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

    const textMatches = dbSearch
      .searchTasks({ match: getSearchMatchExpression(props.query), projectId })
      .filter((row) => !pinnedTasks.some((pinned) => pinned.id === row.id))
      .map(({ project_key, ...row }) => attachTaskKey(row, project_key));

    const matches = filterTasksByLabels([...pinnedTasks, ...textMatches], props.labelNames);
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
    add: (input: TaskLabelInput, actor: Actor): TaskWithKey => {
      const props = validateTaskInput(taskLabelSchema, input);
      return task.edit({ taskKey: props.taskKey, addLabelNames: props.labelNames }, actor);
    },
    remove: (input: TaskLabelInput, actor: Actor): TaskWithKey => {
      const props = validateTaskInput(taskLabelSchema, input);
      return task.edit({ taskKey: props.taskKey, removeLabelNames: props.labelNames }, actor);
    },
  },
  /** Edit task content and label attachments, including on archived tasks. */
  edit: (input: TaskEditInput, actor: Actor) => {
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

      if (isTitleUnchanged && isDescriptionUnchanged && isPriorityUnchanged && areLabelsUnchanged) {
        return existing;
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
        updated_at: now,
      })!;

      updateTaskSearchRecord(existing.id);

      return { ...editedTask, key: existing.key };
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
  order: (props: TaskOrderProps, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);
    const { taskKey, direction } = props;

    return writeTransaction(() => {
      const taskMatch = getTaskByKey(taskKey);

      if (taskMatch.archived_at != null) {
        throw new Error(`Archived task "${taskKey}" cannot be reordered`);
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

          const targetIndex = allTasks.findIndex((candidate) => candidate.id === targetTask.id);
          placement = { direction, targetIndex };
          break;
        }
      }

      const insertionIndex = getInsertionIndex(allTasks.length, taskIndex, placement);

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
