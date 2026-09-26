import type { ColumnCreateInput, ColumnEditInput } from "../schemas/column";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

import { getDb } from "../db";
import * as dbProject from "../db/project";
import * as dbColumn from "../db/column";

import { standardizeProjectKey } from "../lib";
import { columnCreateSchema, columnEditSchema } from "../schemas/column";
import { validateTaskInput } from "../schemas/task";

import { findColumnByName } from "./shared";

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
  create: (input: ColumnCreateInput) => {
    const props = validateTaskInput(columnCreateSchema, input);
    const standardizedKey = standardizeProjectKey(props.projectKey);
    const project = dbProject.getByKey(standardizedKey);

    if (project == null) {
      throw new Error(`Project with key "${standardizedKey}" does not exist!`);
    }

    const allProjectColumns = dbColumn.getAllByProjectId(project.id);
    const existingColumn = findColumnByName(allProjectColumns, props.name);

    if (existingColumn != null) {
      throw new Error(`There is already a "${props.name}" column`);
    }

    const lastColOrder = allProjectColumns[allProjectColumns.length - 1]?.column_order ?? null;

    return dbColumn.create({
      id: randomUUIDv7(),
      name: props.name,
      column_order: generateKeyBetween(lastColOrder, null),
      project_id: project.id,
    })!;
  },
  edit: (input: ColumnEditInput) => {
    const props = validateTaskInput(columnEditSchema, input);

    return getDb().transaction(() => {
      const project = dbProject.getByKey(props.projectKey);

      if (project == null) {
        throw new Error(
          `Project with key "${standardizeProjectKey(props.projectKey)}" does not exist!`,
        );
      }

      const projectColumns = dbColumn.getAllByProjectId(project.id);
      const columnMatch = findColumnByName(projectColumns, props.columnName);

      if (columnMatch == null) {
        throw new Error(`${project.name} does not have a column named "${props.columnName}"`);
      }

      if (props.name === columnMatch.name) {
        return columnMatch;
      }

      const existingColumn = findColumnByName(projectColumns, props.name);
      const isTakenByAnotherColumn = existingColumn != null && existingColumn.id !== columnMatch.id;

      if (isTakenByAnotherColumn) {
        throw new Error(`There is already a "${props.name}" column`);
      }

      return dbColumn.update({ id: columnMatch.id, name: props.name })!;
    })();
  },
};
