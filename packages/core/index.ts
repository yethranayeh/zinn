import type { Column, Task } from "./src/types";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

import * as dbProject from "./src/db/project";
import * as dbColumn from "./src/db/column";
import * as dbTask from "./src/db/task";
import { standardizeProjectKey } from "./src/lib";

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

export const task = {
  create: (task: Pick<Task, "project_id" | "title" | "description">) => {
    const invalidTaskCharRegex = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
    // Tasks are currently rendered as single-line terminal rows, so their text
    // cannot contain control characters or Unicode line separators.
    if (task.title.trim().length === 0 || invalidTaskCharRegex.test(task.title)) {
      throw new Error("Task title must contain printable text on a single line");
    }

    if (task.description != null && invalidTaskCharRegex.test(task.description)) {
      throw new Error("Task description must contain printable text on a single line");
    }

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
  getAll: (props: { projectKey?: string } = {}) => {
    if (props.projectKey == null) {
      return dbTask.getAll();
    }

    const taskProject = dbProject.getByKey(props.projectKey);

    if (taskProject == null) {
      throw new Error(`Project with key "${props.projectKey}" does not exist!`);
    }

    return dbTask.getAllByProjectId(taskProject.id);
  },
  getByKey: getTaskByKey,
  move: (props: { taskKey: string; targetColumn: string }) => {
    const taskMatch = getTaskByKey(props.taskKey);
    const columnMatch = dbColumn
      .getAllByProjectId(taskMatch.project_id)
      .find((c) => c.name === props.targetColumn);

    if (columnMatch == null) {
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
  delete: (taskKey: string) => {
    const taskMatch = getTaskByKey(taskKey);
    return dbTask.deleteById(taskMatch.id);
  },
};
