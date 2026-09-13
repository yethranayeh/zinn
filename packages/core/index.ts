import type { Column } from "./src/types";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

import * as dbProject from "./src/db/project";
import * as dbColumn from "./src/db/column";
import * as dbTask from "./src/db/task";
import { standardizeProjectKey } from "./src/lib";
import { validateTaskInput, taskCreateSchema, taskEditSchema } from "./src/schemas/task";
import type { TaskCreateInput, TaskEditInput } from "./src/schemas/task";

export { taskCreateSchema, taskEditSchema } from "./src/schemas/task";
export type { TaskCreateInput, TaskEditInput } from "./src/schemas/task";

export const project = {
  getById: dbProject.getById,
  getByKey: dbProject.getByKey,
  create: (props: { key: string; name: string }) => {
    const validKeyRegex = /^[A-Za-z][A-Za-z0-9]*$/;
    if (!validKeyRegex.test(props.key)) {
      throw new Error("Project key must start with a letter and contain only letters and numbers");
    }

    const invalidNameCharRegex = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
    // control characters and Unicode line separators are not valid project data.
    if (props.name.trim().length === 0 || invalidNameCharRegex.test(props.name)) {
      throw new Error("Project name must contain printable text on a single line");
    }

    const existingProject = dbProject.getByKey(props.key);

    if (existingProject != null) {
      throw new Error(`Project with key "${existingProject.key}" already exists!`);
    }

    const project = dbProject.create(props)!;

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
  },
  getAll: dbProject.getAll,
  delete: (key: string) => {
    const project = dbProject.getByKey(key);

    if (project == null) {
      throw new Error(`Project with key "${key}" does not exist!`);
    }

    dbProject.deleteByKey(key);
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
      throw new Error(
        `Column with name "${column.name}" already exists in project "${project.key}"!`,
      );
    }

    const lastColOrder = allProjectColumns[allProjectColumns.length - 1]?.column_order ?? null;
    const res = dbColumn.create({
      id: randomUUIDv7(),
      name: column.name,
      column_order: generateKeyBetween(lastColOrder, null),
      project_id: project.id,
    });
  },
};

function getTaskByKey(taskKey: string) {
  const taskKeyMatch = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(taskKey);
  if (taskKeyMatch == null) {
    throw new Error(`Invalid task key "${taskKey}". Expected format PROJECT-1`);
  }

  const projectKey = taskKeyMatch[1]!;
  const taskNumber = Number(taskKeyMatch[2]);
  if (!Number.isSafeInteger(taskNumber) || taskNumber < 1) {
    throw new Error(`Invalid task key "${taskKey}". Expected format PROJECT-1`);
  }

  const project = dbProject.getByKey(projectKey);

  if (project == null) {
    throw new Error(`Project with key "${standardizeProjectKey(projectKey)}" does not exist!`);
  }

  const taskMatch = dbTask.getByProjectIdAndNumber({
    projectId: project.id,
    number: taskNumber,
  });

  if (taskMatch == null) {
    throw new Error(`Task "${project.key}-${taskNumber}" does not exist!`);
  }

  return taskMatch;
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

export const task = {
  create: (input: TaskCreateInput) => {
    const task = validateTaskInput(taskCreateSchema, input);

    // TODO: if anything after this fails, especially the task creation, the counter is still incremented but not assigned to any task
    // TODO: rename
    const project = dbProject.incrementTaskCounterById(task.project_id);

    if (project == null) {
      throw new Error(`Project's next task number could not be retrieved  (ID:${task.project_id})`);
    }

    const initialColumn = dbColumn.getAllByProjectId(task.project_id)[0]!;
    const lastTask = dbTask.getLastByColumnId(initialColumn.id);
    const order = generateKeyBetween(lastTask?.task_order ?? null, null);

    const now = Date.now();
    return dbTask.create({
      id: randomUUIDv7(),
      project_id: task.project_id,
      column_id: initialColumn.id,
      number: project.task_count,
      title: task.title,
      description: task.description,
      task_order: order,
      created_at: now,
      updated_at: now,
    });
  },
  getAll: (props: { projectKey?: string; archive?: dbTask.TaskArchiveFilter } = {}) => {
    if (props.projectKey == null) {
      return dbTask.getAll(props.archive);
    }

    const taskProject = dbProject.getByKey(props.projectKey);

    if (taskProject == null) {
      throw new Error(`Project with key "${props.projectKey}" does not exist!`);
    }

    return dbTask.getAllByProjectId(taskProject.id, props.archive);
  },
  getByKey: getTaskByKey,
  /** Edit supplied content fields, including on archived tasks. Unchanged edits are no-ops. */
  edit: (input: TaskEditInput) => {
    const props = validateTaskInput(taskEditSchema, input);
    const existing = getTaskByKey(props.taskKey);
    const isTitleUnchanged = props.title === undefined || props.title === existing.title;
    const isDescriptionUnchanged =
      props.description === undefined || props.description === existing.description;

    if (isTitleUnchanged && isDescriptionUnchanged) {
      return existing;
    }

    return dbTask.update({
      id: existing.id,
      title: props.title,
      description: props.description,
      updated_at: Date.now(),
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
  move: (props: { taskKey: string; targetColumn: string }) => {
    const taskMatch = getTaskByKey(props.taskKey);

    if (taskMatch.archived_at != null) {
      throw new Error(`Archived task "${props.taskKey}" cannot be moved`);
    }

    const columnMatch = dbColumn
      .getAllByProjectId(taskMatch.project_id)
      .find((column) => column.name.toLowerCase() === props.targetColumn.toLowerCase());

    if (columnMatch == null) {
      // TODO: maybe a `did you mean` type of fuzzy check for misspelllings
      throw new Error(
        `Column "${props.targetColumn}" does not exist in task "${props.taskKey}"'s project!`,
      );
    }

    if (columnMatch.id === taskMatch.column_id) {
      return taskMatch;
    }

    const lastTask = dbTask.getLastByColumnId(columnMatch.id);
    const order = generateKeyBetween(lastTask?.task_order ?? null, null);

    return dbTask.update({
      id: taskMatch.id,
      column_id: columnMatch.id,
      task_order: order,
      updated_at: Date.now(),
    });
  },
  order: (props: TaskOrderProps) => {
    const { taskKey, direction } = props;
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

    return dbTask.update({
      id: taskMatch.id,
      task_order: generateKeyBetween(
        futurePrevTask?.task_order ?? null,
        futureNextTask?.task_order ?? null,
      ),
      updated_at: Date.now(),
    });
  },
  delete: (taskKey: string) => {
    const taskMatch = getTaskByKey(taskKey);
    return dbTask.deleteById(taskMatch.id);
  },
  archive: (taskKey: string) => {
    const taskMatch = getTaskByKey(taskKey);

    if (taskMatch.archived_at != null) {
      return taskMatch;
    }

    const now = Date.now();
    return dbTask.update({ id: taskMatch.id, updated_at: now, archived_at: now });
  },
  unarchive: (taskKey: string) => {
    const taskMatch = getTaskByKey(taskKey);

    if (taskMatch.archived_at == null) {
      return taskMatch;
    }

    const lastTask = dbTask.getLastByColumnId(taskMatch.column_id);
    const order = generateKeyBetween(lastTask?.task_order ?? null, null);

    return dbTask.update({
      id: taskMatch.id,
      task_order: order,
      updated_at: Date.now(),
      archived_at: null,
    });
  },
};
