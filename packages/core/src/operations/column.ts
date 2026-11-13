import type {
  ColumnCreateInput,
  ColumnEditInput,
  ColumnDeleteInput,
  ColumnOrderInput,
  ColumnInspectionInput,
} from "../schemas/column.js";
import type { Actor } from "../schemas/actor.js";
import type { ColumnChange } from "../types.js";
import type { OrderPlacement } from "./shared.js";

import { v7 as uuidv7 } from "uuid";
import { generateKeyBetween } from "fractional-indexing";

import { writeTransaction } from "../db.js";
import * as dbProject from "../db/project.js";
import * as dbColumn from "../db/column.js";
import * as dbTask from "../db/task.js";

import { CoreError } from "../errors.js";
import { standardizeProjectKey } from "../lib.js";
import { getStorage } from "../storage.js";
import { classifyConnection, withDatabaseInspection } from "../migrations/classify.js";
import { findByName, getInsertionIndex, recordActivity, requireColumnByName } from "./shared.js";
import {
  columnCreateSchema,
  columnEditSchema,
  columnDeleteSchema,
  columnOrderSchema,
  columnInspectionSchema,
} from "../schemas/column.js";
import { actorSchema } from "../schemas/actor.js";
import { parseTaskKey, validateTaskInput } from "../schemas/task.js";

function requireProjectColumns(projectKey: string) {
  const project = dbProject.getByKey(projectKey);

  if (project == null) {
    throw new CoreError(
      `Project with key "${standardizeProjectKey(projectKey)}" does not exist`,
      "missing",
      { entity: "project", key: standardizeProjectKey(projectKey) },
    );
  }

  return { project, projectColumns: dbColumn.getAllByProjectId(project.id) };
}

export const column = {
  /** Inspects existing column names and task identities without initializing or upgrading storage. */
  inspect: (input: ColumnInspectionInput = {}) => {
    const props = validateTaskInput(columnInspectionSchema, input);

    return withDatabaseInspection(getStorage().databasePath, (db) => {
      const classification = classifyConnection(db);
      if (classification.state === "empty" || classification.state === "unmarked") {
        return null;
      }

      const requestedTasks = props.taskKeys.flatMap((key) => {
        const parsed = parseTaskKey(key);
        return parsed === null
          ? []
          : [{ ...parsed, projectKey: standardizeProjectKey(parsed.projectKey) }];
      });

      const facts = dbColumn.inspectContext(db, requestedTasks);
      return {
        projects: facts.projects.map(({ id, key }) => ({
          key,
          columns: facts.columns
            .filter((entry) => entry.project_id === id)
            .map((entry) => entry.name),
        })),
        taskKeys: facts.tasks.map((entry) => `${entry.project_key}-${entry.number}`),
      };
    });
  },
  getById: dbColumn.getById,
  getByName: (projectKey: string, columnName: string) => {
    const { project, projectColumns } = requireProjectColumns(projectKey);
    return requireColumnByName(project, projectColumns, columnName).columnMatch;
  },
  getAllByProjectKey: (key: string) => requireProjectColumns(key).projectColumns,
  getTaskCountsByProjectKey: (key: string) => {
    const { project, projectColumns } = requireProjectColumns(key);
    const activeCountsByColumnId = new Map(
      dbTask.countByColumnId(project.id, "active").map((row) => [row.column_id, row.task_count]),
    );
    const archivedCounts = dbTask.countByColumnId(project.id, "archived");
    const archivedCountsByColumnId = new Map(
      archivedCounts.map((row) => [row.column_id, row.task_count]),
    );

    /** Columns come in board order. taskCount counts unarchived tasks, and archivedTaskCount totals the archived ones across columns. */
    return {
      columns: projectColumns.map((columnMatch) => ({
        column: columnMatch,
        taskCount: activeCountsByColumnId.get(columnMatch.id) ?? 0,
        archivedTaskCount: archivedCountsByColumnId.get(columnMatch.id) ?? 0,
      })),
      archivedTaskCount: archivedCounts.reduce((total, row) => total + row.task_count, 0),
    };
  },
  create: (input: ColumnCreateInput, actor: Actor) => {
    const props = validateTaskInput(columnCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const { project, projectColumns: allProjectColumns } = requireProjectColumns(
        props.projectKey,
      );
      const existingColumn = findByName(allProjectColumns, props.name);

      if (existingColumn != null) {
        throw new CoreError(`There is already a "${props.name}" column`, "conflict", {
          entity: "column",
          key: props.name,
          reason: "already_exists",
        });
      }

      const lastColOrder = allProjectColumns[allProjectColumns.length - 1]?.column_order ?? null;
      const createdColumn = dbColumn.create({
        id: uuidv7(),
        name: props.name,
        column_order: generateKeyBetween(lastColOrder, null),
        project_id: project.id,
        category: props.category,
      })!;

      recordActivity(validActor, {
        entityType: "column",
        entityId: createdColumn.id,
        action: "create",
        changes: {
          project: { id: project.id, key: project.key },
          name: createdColumn.name,
          category: createdColumn.category,
        },
        createdAt: Date.now(),
      });

      return createdColumn;
    });
  },
  edit: (input: ColumnEditInput, actor: Actor): ColumnChange => {
    const props = validateTaskInput(columnEditSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const { project, projectColumns } = requireProjectColumns(props.projectKey);
      const { columnMatch } = requireColumnByName(project, projectColumns, props.columnName);
      const name = props.name ?? columnMatch.name;
      // Writes run only on the current schema where every column has a category
      const currentCategory = columnMatch.category!;
      const category = props.category ?? currentCategory;

      if (name === columnMatch.name && category === currentCategory) {
        return { column: columnMatch, changed: false };
      }

      const existingColumn = findByName(projectColumns, name);
      const isTakenByAnotherColumn = existingColumn != null && existingColumn.id !== columnMatch.id;

      if (isTakenByAnotherColumn) {
        throw new CoreError(`There is already a "${name}" column`, "conflict", {
          entity: "column",
          key: name,
          reason: "already_exists",
        });
      }

      const changes: Record<string, unknown> = {};
      if (name !== columnMatch.name) {
        changes.name = [columnMatch.name, name];
      }

      if (category !== currentCategory) {
        changes.category = [currentCategory, category];
      }

      recordActivity(validActor, {
        entityType: "column",
        entityId: columnMatch.id,
        action: "edit",
        changes,
        createdAt: Date.now(),
      });

      const editedColumn = dbColumn.update({ id: columnMatch.id, name, category })!;
      return { column: editedColumn, changed: true };
    });
  },
  order: (input: ColumnOrderInput, actor: Actor): ColumnChange => {
    const props = validateTaskInput(columnOrderSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const { project, projectColumns } = requireProjectColumns(props.projectKey);
      const { columnMatch, columnIndex } = requireColumnByName(
        project,
        projectColumns,
        props.columnName,
      );
      let placement: OrderPlacement;

      switch (props.direction) {
        case "first":
        case "previous":
        case "next":
        case "last":
          placement = { direction: props.direction };
          break;
        case "before":
        case "after": {
          const { columnIndex: targetIndex } = requireColumnByName(
            project,
            projectColumns,
            props.targetColumnName,
          );

          if (targetIndex === columnIndex) {
            return { column: columnMatch, changed: false };
          }

          placement = { direction: props.direction, targetIndex };
          break;
        }
      }

      const insertionIndex = getInsertionIndex(projectColumns.length, columnIndex, placement);

      if (insertionIndex === columnIndex) {
        return { column: columnMatch, changed: false };
      }

      const otherColumns = projectColumns.filter((candidate) => candidate.id !== columnMatch.id);
      const futurePrevColumn = otherColumns[insertionIndex - 1] ?? null;
      const futureNextColumn = otherColumns[insertionIndex] ?? null;

      recordActivity(validActor, {
        entityType: "column",
        entityId: columnMatch.id,
        action: "order",
        changes: null,
        createdAt: Date.now(),
      });

      const orderedColumn = dbColumn.updateOrder({
        id: columnMatch.id,
        column_order: generateKeyBetween(
          futurePrevColumn?.column_order ?? null,
          futureNextColumn?.column_order ?? null,
        ),
      })!;

      return { column: orderedColumn, changed: true };
    });
  },
  delete: (input: ColumnDeleteInput, actor: Actor) => {
    const props = validateTaskInput(columnDeleteSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const { project, projectColumns } = requireProjectColumns(props.projectKey);
      const { columnMatch } = requireColumnByName(project, projectColumns, props.columnName);
      const activeTaskCount =
        dbTask
          .countByColumnId(project.id, "active")
          .find((entry) => entry.column_id === columnMatch.id)?.task_count ?? 0;
      const archivedTaskCount =
        dbTask
          .countByColumnId(project.id, "archived")
          .find((entry) => entry.column_id === columnMatch.id)?.task_count ?? 0;

      if (activeTaskCount + archivedTaskCount > 0) {
        throw new CoreError(
          `Column "${columnMatch.name}" contains ${activeTaskCount} active and ${archivedTaskCount} archived tasks`,
          "conflict",
          { entity: "column", key: columnMatch.name, reason: "has_tasks" },
        );
      }

      const deletedColumn = dbColumn.deleteById(columnMatch.id)!;
      recordActivity(validActor, {
        entityType: "column",
        entityId: deletedColumn.id,
        action: "delete",
        changes: { project: { id: project.id, key: project.key }, name: deletedColumn.name },
        createdAt: Date.now(),
      });
      return deletedColumn;
    });
  },
};
