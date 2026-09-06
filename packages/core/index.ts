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

export const task = {
  create: (task: Pick<Task, "project_id" | "name" | "description">) => {
    // TODO: if anything after this fails, especially the task creation, the counter is still incremented but not assigned to any task
    const project = dbProject.incrementTaskCounterById(task.project_id);

    if (project == null) {
      throw new Error(`Project's next task number could not be retrieved  (ID:${task.project_id})`);
    }

    // TODO: do proper refined query
    // FIXME: returns all tasks from *all* projects
    const allTasks = dbTask.getAll();

    let previousTaskOrder = null;
    if (allTasks.length > 0) {
      const lastTask = allTasks[allTasks.length - 1]!;
      previousTaskOrder = lastTask.task_order;
    }

    const order = generateKeyBetween(previousTaskOrder, null);

    const now = Date.now();
    return dbTask.create({
      id: randomUUIDv7(),
      project_id: task.project_id,
      number: project.task_count,
      name: task.name,
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
  getByKey: (taskKey: string) => {
    const parts = taskKey.split("-");

    if (parts.length !== 2) {
      // TODO
      throw new Error();
    }

    const projectKey = parts[0];
    const taskNumber = parts[1];

    if (projectKey == null || taskNumber == null) {
      // TODO
      throw new Error();
    }

    // Posted by Mike Samuel
    // Retrieved 2026-09-06, License - CC BY-SA 3.0
    // Source - https://stackoverflow.com/a/9011554
    const digitRegex = /^\d+$/;
    const isTaskNumberDigit = digitRegex.test(taskNumber);

    if (!isTaskNumberDigit) {
      // TODO
      throw new Error();
    }

    // TODO: validate part types?

    const project = dbProject.getByKey(projectKey);

    if (project == null) {
      // TODO
      throw new Error();
    }

    const taskMatch = dbTask.getByProjectIdAndNumber({
      projectId: project.id,
      number: parseInt(taskNumber),
    });

    if (taskMatch == null) {
      // TODO
      throw new Error();
    }

    return taskMatch;
  },
};
