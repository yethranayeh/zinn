import type { ProjectCreateInput, ProjectEditInput } from "../schemas/project.js";
import type { Actor } from "../schemas/actor.js";
import type { ProjectChange } from "../types.js";

import { v7 as uuidv7 } from "uuid";
import { generateKeyBetween } from "fractional-indexing";

import {
  validateProjectInput,
  projectCreateSchema,
  projectEditSchema,
} from "../schemas/project.js";
import { CoreError } from "../errors.js";
import { actorSchema } from "../schemas/actor.js";
import { validateTaskInput } from "../schemas/task.js";

import { writeTransaction } from "../db.js";
import * as dbProject from "../db/project.js";
import * as dbColumn from "../db/column.js";
import * as dbTask from "../db/task.js";
import * as dbSearch from "../db/search.js";
import * as dbRelation from "../db/relation.js";

import { standardizeProjectKey } from "../lib.js";
import {
  attachTaskKey,
  describeRelation,
  recordActivity,
  recordTaskActivity,
  resolveDescription,
} from "./shared.js";

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
        throw new CoreError(
          `Project with key "${existingProject.key}" already exists!`,
          "conflict",
          { entity: "project", key: existingProject.key, reason: "already_exists" },
        );
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
  edit: (input: ProjectEditInput, actor: Actor): ProjectChange => {
    const props = validateProjectInput(projectEditSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const projectMatch = dbProject.getByKey(props.projectKey);

      if (projectMatch == null) {
        throw new CoreError(
          `Project with key "${standardizeProjectKey(props.projectKey)}" does not exist`,
          "missing",
          { entity: "project", key: standardizeProjectKey(props.projectKey) },
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
        return { project: projectMatch, changed: false };
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

      const editedProject = dbProject.update({
        id: projectMatch.id,
        name,
        description,
        updated_at: now,
      })!;

      return { project: editedProject, changed: true };
    });
  },
  getAll: dbProject.getAll,
  getAllWithTaskCounts: () => {
    const countsByProjectId = new Map(
      dbTask
        .countByProjectId()
        .map(({ project_id, active, archived }) => [project_id, { active, archived }]),
    );

    return dbProject.getAll().map((projectMatch) => ({
      ...projectMatch,
      taskCounts: countsByProjectId.get(projectMatch.id) ?? { active: 0, archived: 0 },
    }));
  },
  delete: (key: string, actor: Actor) => {
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const projectMatch = dbProject.getByKey(key);

      if (projectMatch == null) {
        throw new CoreError(`Project with key "${key}" does not exist`, "missing", {
          entity: "project",
          key,
        });
      }

      const columns = dbColumn
        .getAllByProjectId(projectMatch.id)
        .map((columnMatch) => ({ id: columnMatch.id, name: columnMatch.name }));
      const projectTasks = dbTask.getAllByProjectId(projectMatch.id, "all");
      const tasks = projectTasks.map((taskMatch) => {
        const keyedTask = attachTaskKey(taskMatch, projectMatch.key);
        return { id: keyedTask.id, key: keyedTask.key, title: keyedTask.title };
      });
      const deletedTaskIds = new Set(projectTasks.map(({ id }) => id));
      const now = Date.now();

      for (const taskMatch of projectTasks) {
        for (const relationMatch of dbRelation.getAllByTaskId(taskMatch.id)) {
          const otherTaskId =
            relationMatch.source_task_id === taskMatch.id
              ? relationMatch.target_task_id
              : relationMatch.source_task_id;

          if (deletedTaskIds.has(otherTaskId)) {
            continue;
          }

          recordTaskActivity(validActor, {
            taskId: otherTaskId,
            action: "relation_delete",
            changes: describeRelation(relationMatch),
            createdAt: now,
          });
        }
      }

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
        createdAt: now,
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
