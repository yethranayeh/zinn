import type { Column } from "../types";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

import * as dbProject from "../db/project";
import * as dbColumn from "../db/column";

import { standardizeProjectKey } from "../lib";

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
    const existingColumn = allProjectColumns.find(
      (existing) => existing.name.toLowerCase() === column.name.toLowerCase(),
    );

    if (existingColumn != null) {
      throw new Error(`There is already a "${column.name}" column`);
    }

    const lastColOrder = allProjectColumns[allProjectColumns.length - 1]?.column_order ?? null;

    return dbColumn.create({
      id: randomUUIDv7(),
      name: column.name,
      column_order: generateKeyBetween(lastColOrder, null),
      project_id: project.id,
    })!;
  },
};
