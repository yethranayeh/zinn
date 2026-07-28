import type { Task } from "./src/types";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

// TODO: do not initialize before the first "valid" command
import "./src/config";
import { addProject, getProjectByKey, deleteProjectByKey } from "./src/db";
import * as dbProject from "./src/db/project";
import * as dbTask from "./src/db/task";
import { standardizeProjectKey } from "./src/lib";

// TODO: delete after refactor
function standardizeKey(key: string) {
  // TODO: maybe force latin characters only to prevent unexpected stuff from charaters like Ğ, İ, etc.
  return key.toUpperCase();
}

export function createProject({ key, name }: { key: string; name: string }) {
  const standardizedKey = standardizeKey(key);
  const project = getProjectByKey(standardizedKey);

  if (project != null) {
    throw new Error(`Project with key "${standardizedKey}" already exists!`);
  }

  addProject(standardizedKey, name);
}

export function deleteProject(key: string) {
  const standardizedKey = standardizeKey(key);
  const project = getProjectByKey(standardizedKey);

  if (project == null) {
    throw new Error(`Project with key "${standardizedKey}" does not exist!`);
  }

  deleteProjectByKey(standardizedKey);
}

export const project = {
  getByKey: dbProject.getByKey,
  standardizeKey: standardizeProjectKey,
};

export const task = {
  create: (task: Pick<Task, "project_id" | "name" | "description">) => {
    // TODO: if anything after this fails, especially the task creation, the counter is still incremented but not assigned to any task
    const project = dbProject.incrementTaskCounterById(task.project_id);

    if (project == null) {
      throw new Error(`Project's next task number could not be retrieved  (ID:${task.project_id})`);
    }

    // TODO: do proper refined query
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
};
