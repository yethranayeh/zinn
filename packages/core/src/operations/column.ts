import type { Column, Project } from "../types";
import type { ColumnCreateInput, ColumnEditInput, ColumnOrderInput } from "../schemas/column";
import type { OrderPlacement } from "./shared";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

import { getDb } from "../db";
import * as dbProject from "../db/project";
import * as dbColumn from "../db/column";

import { standardizeProjectKey } from "../lib";
import { columnCreateSchema, columnEditSchema, columnOrderSchema } from "../schemas/column";
import { validateTaskInput } from "../schemas/task";

import { findColumnByName, getInsertionIndex } from "./shared";

function requireProjectColumns(projectKey: string) {
  const project = dbProject.getByKey(projectKey);

  if (project == null) {
    throw new Error(`Project with key "${standardizeProjectKey(projectKey)}" does not exist!`);
  }

  return { project, projectColumns: dbColumn.getAllByProjectId(project.id) };
}

function requireColumnByName(project: Project, projectColumns: Array<Column>, name: string) {
  const columnMatch = findColumnByName(projectColumns, name);

  if (columnMatch == null) {
    throw new Error(`${project.name} does not have a column named "${name}"`);
  }

  return { columnMatch, columnIndex: projectColumns.indexOf(columnMatch) };
}

export const column = {
  getById: dbColumn.getById,
  getAllByProjectKey: (key: string) => requireProjectColumns(key).projectColumns,
  create: (input: ColumnCreateInput) => {
    const props = validateTaskInput(columnCreateSchema, input);
    const { project, projectColumns: allProjectColumns } = requireProjectColumns(props.projectKey);
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
      const { project, projectColumns } = requireProjectColumns(props.projectKey);
      const { columnMatch } = requireColumnByName(project, projectColumns, props.columnName);

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
  order: (input: ColumnOrderInput) => {
    const props = validateTaskInput(columnOrderSchema, input);

    return getDb().transaction(() => {
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
            return columnMatch;
          }

          placement = { direction: props.direction, targetIndex };
          break;
        }
      }

      const insertionIndex = getInsertionIndex(projectColumns.length, columnIndex, placement);

      if (insertionIndex === columnIndex) {
        return columnMatch;
      }

      const otherColumns = projectColumns.filter((candidate) => candidate.id !== columnMatch.id);
      const futurePrevColumn = otherColumns[insertionIndex - 1] ?? null;
      const futureNextColumn = otherColumns[insertionIndex] ?? null;

      return dbColumn.updateOrder({
        id: columnMatch.id,
        column_order: generateKeyBetween(
          futurePrevColumn?.column_order ?? null,
          futureNextColumn?.column_order ?? null,
        ),
      })!;
    })();
  },
};
