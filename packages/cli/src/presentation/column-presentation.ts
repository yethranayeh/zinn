import type { RowCell } from "./row-layout.js";

import { formatRows } from "./row-layout.js";

type ColumnRow = { name: string; project?: string; taskCount?: number };

/** Archived tasks are off the board, so they share one row below the columns instead of a column of their own. */
const ARCHIVED_ROW_LABEL = "Archived";

export function columnNameCell(columnName: string): RowCell {
  // TODO: Derive column colors from column roles once roles exist instead of relying on names.
  if (columnName === "Backlog") {
    return { text: columnName, style: "gray" };
  }

  if (columnName === "Done") {
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

    const taskCountCells: Array<RowCell> =
      options.showsTaskCounts && presentedColumn.taskCount != null
        ? [{ text: String(presentedColumn.taskCount) }]
        : [];

    return [...projectCells, columnNameCell(presentedColumn.name), ...taskCountCells];
  });

  if (options.archivedTaskCount != null && options.archivedTaskCount > 0) {
    rows.push([{ text: ARCHIVED_ROW_LABEL }, { text: String(options.archivedTaskCount) }]);
  }

  return formatRows(rows);
}
