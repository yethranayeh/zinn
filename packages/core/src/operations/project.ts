import type { ProjectCreateInput, ProjectEditInput } from "../schemas/project";
import type { Actor } from "../schemas/actor";
import { validateProjectInput, projectCreateSchema, projectEditSchema } from "../schemas/project";
import { actorSchema } from "../schemas/actor";
import { validateTaskInput } from "../schemas/task";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

import { getDb } from "../db";
import * as dbProject from "../db/project";
import * as dbColumn from "../db/column";
import * as dbTask from "../db/task";
import * as dbSearch from "../db/search";

import { standardizeProjectKey } from "../lib";
import { attachTaskKey, recordActivity } from "./shared";

export const project = {
  getById: dbProject.getById,
  getByKey: dbProject.getByKey,
  create: (input: ProjectCreateInput, actor: Actor) => {
    const props = validateProjectInput(projectCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);
    const existingProject = dbProject.getByKey(props.key);

    if (existingProject != null) {
      throw new Error(`Project with key "${existingProject.key}" already exists!`);
    }

    return getDb().transaction(() => {
      const key = standardizeProjectKey(props.key);
      const createdProject = dbProject.create({ key, name: props.name ?? key })!;
      const defaultColumnNames = ["Backlog", "TODO", "In Progress", "Review", "Done"];
      const createdColumns: Array<{ id: string; name: string }> = [];
      let lastColumnOrder: string | null = null;

      for (const name of defaultColumnNames) {
        const columnOrder = generateKeyBetween(lastColumnOrder, null);
        const createdColumn = dbColumn.create({
          id: randomUUIDv7(),
          project_id: createdProject.id,
          name,
          column_order: columnOrder,
        })!;
        createdColumns.push({ id: createdColumn.id, name: createdColumn.name });
        lastColumnOrder = columnOrder;
      }

      recordActivity(validActor, {
        entityType: "project",
        entityId: createdProject.id,
        action: "create",
        changes: {
          key: createdProject.key,
          name: createdProject.name,
          columns: createdColumns,
        },
        createdAt: createdProject.created_at,
      });

      return createdProject;
    })();
  },
  /** Rename a project. Same name does not alter the timestamp */
  edit: (input: ProjectEditInput, actor: Actor) => {
    const props = validateProjectInput(projectEditSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const projectMatch = dbProject.getByKey(props.projectKey);

      if (projectMatch == null) {
        throw new Error(
          `Project with key "${standardizeProjectKey(props.projectKey)}" does not exist!`,
        );
      }

      if (props.name === projectMatch.name) {
        return projectMatch;
      }

      const now = Date.now();
      recordActivity(validActor, {
        entityType: "project",
        entityId: projectMatch.id,
        action: "edit",
        changes: { name: [projectMatch.name, props.name] },
        createdAt: now,
      });

      return dbProject.update({ id: projectMatch.id, name: props.name, updated_at: now })!;
    })();
  },
  getAll: dbProject.getAll,
  delete: (key: string, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const projectMatch = dbProject.getByKey(key);

      if (projectMatch == null) {
        throw new Error(`Project with key "${key}" does not exist!`);
      }

      const columns = dbColumn
        .getAllByProjectId(projectMatch.id)
        .map((columnMatch) => ({ id: columnMatch.id, name: columnMatch.name }));
      const projectTasks = dbTask.getAllByProjectId(projectMatch.id, "all");
      const tasks = projectTasks.map((taskMatch) => {
        const keyedTask = attachTaskKey(taskMatch, projectMatch.key);
        return { id: keyedTask.id, key: keyedTask.key, title: keyedTask.title };
      });

      recordActivity(validActor, {
        entityType: "project",
        entityId: projectMatch.id,
        action: "delete",
        changes: { key: projectMatch.key, name: projectMatch.name, columns, tasks },
        createdAt: Date.now(),
      });

      for (const taskMatch of projectTasks) {
        dbSearch.removeTask(taskMatch.id);
      }

      dbProject.deleteByKey(key);
      return projectMatch;
    })();
  },
  standardizeKey: standardizeProjectKey,
};
