import type { ColumnCategory } from "@zinn-dev/core";
import type { RowCell } from "./row-layout.js";
import type { PresentedColumn, PresentedColumnTaskCount } from "../result-schemas.js";

import { column, project } from "@zinn-dev/core";

import { formatRows } from "./row-layout.js";

type ColumnRow = {
  name: string;
  category?: string | null;
  project?: string;
  taskCount?: number;
  is_first?: boolean;
  is_last?: boolean;
};

/** Archived tasks are off the board, so they share one row below the columns instead of a column of their own. */
const ARCHIVED_ROW_LABEL = "Archived";

/** A project's columns in board order. */
export type ProjectColumns = ReturnType<typeof column.getAllByProjectKey>;

/** Reads each project's columns once, so presenting many rows costs one read per project. */
export type ColumnBoard = (projectId: string) => ProjectColumns;

export function createColumnBoard(): ColumnBoard {
  const projectColumnsByProjectId = new Map<string, ProjectColumns>();

  return (projectId) => {
    const cachedColumns = projectColumnsByProjectId.get(projectId);
    if (cachedColumns != null) {
      return cachedColumns;
    }

    const boardColumns = column.getAllByProjectKey(project.getById(projectId)!.key);
    projectColumnsByProjectId.set(projectId, boardColumns);
    return boardColumns;
  };
}

/** A column off its board, such as a deleted one, has no placement and no color. */
export function columnPlacement(projectColumns: ProjectColumns, columnId: string) {
  const columnIndex = projectColumns.findIndex((boardColumn) => boardColumn.id === columnId);
  const isOnBoard = columnIndex !== -1;

  return {
    is_first: isOnBoard && columnIndex === 0,
    is_last: isOnBoard && columnIndex === projectColumns.length - 1,
  };
}

export function presentColumn(columnMatch: {
  id: string;
  project_id: string;
  name: string;
  category?: ColumnCategory;
}): PresentedColumn {
  const columnProject = project.getById(columnMatch.project_id)!;
  const placement = columnPlacement(column.getAllByProjectKey(columnProject.key), columnMatch.id);

  return {
    id: columnMatch.id,
    project: columnProject.key,
    project_id: columnMatch.project_id,
    name: columnMatch.name,
    is_first: placement.is_first,
    is_last: placement.is_last,
    category: columnMatch.category ?? null,
  };
}

/** Shapes one board's column rows, in order, with the placement each name is colored by. */
export function presentColumnTaskCounts(
  taskCounts: ReturnType<typeof column.getTaskCountsByProjectKey>,
): Array<PresentedColumnTaskCount> {
  const lastColumnIndex = taskCounts.columns.length - 1;

  return taskCounts.columns.map((columnCount, columnIndex) => ({
    id: columnCount.column.id,
    name: columnCount.column.name,
    is_first: columnIndex === 0,
    is_last: columnIndex === lastColumnIndex,
    category: columnCount.column.category ?? null,
    taskCount: columnCount.taskCount,
  }));
}

export function columnNameCell(
  columnName: string,
  placement: Pick<ColumnRow, "is_first" | "is_last"> = {},
): RowCell {
  // A board's first column is gray and its last is green. A one-column board is both, and colors as first.
  if (placement.is_first) {
    return { text: columnName, style: "gray" };
  }

  if (placement.is_last) {
    return { text: columnName, style: "green" };
  }

  return { text: columnName };
}

/** The archived row is left out when there are no archived tasks. */
export function formatColumnList(
  presentedColumns: Array<ColumnRow>,
  options: { showsProject?: boolean; showsTaskCounts?: boolean; archivedTaskCount?: number } = {},
) {
  const rows: Array<Array<RowCell>> = presentedColumns.map((presentedColumn) => {
    const projectCells: Array<RowCell> =
      options.showsProject && presentedColumn.project != null
        ? [{ text: presentedColumn.project }]
        : [];

    // The cell stays, empty, for a column without a category on an older database.
    const categoryCells: Array<RowCell> =
      presentedColumn.category === undefined ? [] : [{ text: presentedColumn.category ?? "" }];

    const taskCountCells: Array<RowCell> =
      options.showsTaskCounts && presentedColumn.taskCount != null
        ? [{ text: String(presentedColumn.taskCount) }]
        : [];

    return [
      ...projectCells,
      columnNameCell(presentedColumn.name, presentedColumn),
      ...categoryCells,
      ...taskCountCells,
    ];
  });

  if (options.archivedTaskCount != null && options.archivedTaskCount > 0) {
    // An empty cell keeps the count under the task counts when rows show categories.
    const hasCategoryCell = presentedColumns.some(
      (presentedColumn) => presentedColumn.category !== undefined,
    );
    rows.push([
      { text: ARCHIVED_ROW_LABEL },
      ...(hasCategoryCell ? [{ text: "" }] : []),
      { text: String(options.archivedTaskCount) },
    ]);
  }

  return formatRows(rows);
}
