import type { ProjectCreateInput, ProjectEditInput } from "../schemas/project";
import { validateProjectInput, projectCreateSchema, projectEditSchema } from "../schemas/project";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

import { getDb } from "../db";
import * as dbProject from "../db/project";
import * as dbColumn from "../db/column";
import * as dbTask from "../db/task";
import * as dbSearch from "../db/search";

import { standardizeProjectKey } from "../lib";

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
        dbSearch.removeTask(taskMatch.id);
      }

      dbProject.deleteByKey(key);
    })();
    return project;
  },
  standardizeKey: standardizeProjectKey,
};
