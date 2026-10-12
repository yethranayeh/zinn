import type { ProjectCreateInput, ProjectEditInput } from "../schemas/project.js";
import type { Actor } from "../schemas/actor.js";
import { validateProjectInput, projectCreateSchema, projectEditSchema } from "../schemas/project.js";
import { actorSchema } from "../schemas/actor.js";
import { validateTaskInput } from "../schemas/task.js";

import { v7 as uuidv7 } from "uuid";
import { generateKeyBetween } from "fractional-indexing";

import { writeTransaction } from "../db.js";
import * as dbProject from "../db/project.js";
import * as dbColumn from "../db/column.js";
import * as dbTask from "../db/task.js";
import * as dbSearch from "../db/search.js";

import { standardizeProjectKey } from "../lib.js";
import { attachTaskKey, recordActivity, resolveDescription } from "./shared.js";

export const project = {
  getById: dbProject.getById,
  getByKey: dbProject.getByKey,
  create: (input: ProjectCreateInput, actor: Actor) => {
    const props = validateProjectInput(projectCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      // Checked inside the transaction, so another process cannot add the key in between.
      const existingProject = dbProject.getByKey(props.key);

      if (existingProject != null) {
        throw new Error(`Project with key "${existingProject.key}" already exists!`);
      }

      const key = standardizeProjectKey(props.key);
      const createdProject = dbProject.create({
        key,
        name: props.name ?? key,
        description: props.description,
      })!;
      const defaultColumnNames = ["Backlog", "TODO", "In Progress", "Review", "Done"];
      const createdColumns: Array<{ id: string; name: string }> = [];
      let lastColumnOrder: string | null = null;

      for (const name of defaultColumnNames) {
        const columnOrder = generateKeyBetween(lastColumnOrder, null);
        const createdColumn = dbColumn.create({
          id: uuidv7(),
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
          description: createdProject.description,
          columns: createdColumns,
        },
        createdAt: createdProject.created_at,
      });

      return createdProject;
    });
  },
  edit: (input: ProjectEditInput, actor: Actor) => {
    const props = validateProjectInput(projectEditSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const projectMatch = dbProject.getByKey(props.projectKey);

      if (projectMatch == null) {
        throw new Error(
          `Project with key "${standardizeProjectKey(props.projectKey)}" does not exist!`,
        );
      }

      const name = props.name ?? projectMatch.name;
      const description =
        props.description === undefined
          ? projectMatch.description
          : resolveDescription(
              props.description,
              projectMatch.description,
              `project ${projectMatch.key}'s description`,
            );
      const isUnchanged = name === projectMatch.name && description === projectMatch.description;
      if (isUnchanged) {
        return projectMatch;
      }

      const changes: Record<string, unknown> = {};
      if (name !== projectMatch.name) {
        changes.name = [projectMatch.name, name];
      }

      if (description !== projectMatch.description) {
        changes.description = [projectMatch.description, description];
      }

      const now = Date.now();
      recordActivity(validActor, {
        entityType: "project",
        entityId: projectMatch.id,
        action: "edit",
        changes,
        createdAt: now,
      });

      return dbProject.update({ id: projectMatch.id, name, description, updated_at: now })!;
    });
  },
  getAll: dbProject.getAll,
  delete: (key: string, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
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
        changes: {
          key: projectMatch.key,
          name: projectMatch.name,
          description: projectMatch.description,
          columns,
          tasks,
        },
        createdAt: Date.now(),
      });

      for (const taskMatch of projectTasks) {
        dbSearch.removeTask(taskMatch.id);
      }

      dbProject.deleteByKey(key);
      return projectMatch;
    });
  },
  standardizeKey: standardizeProjectKey,
};
