import type { RowCell } from "./row-layout";

import { formatRows } from "./row-layout";

export type PresentedColumnTaskCount = { name: string; taskCount: number };

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
export function formatColumnTaskCounts(
  presentedColumns: Array<PresentedColumnTaskCount>,
  options: { archivedTaskCount: number },
) {
  const rows: Array<Array<RowCell>> = presentedColumns.map((presentedColumn) => [
    columnNameCell(presentedColumn.name),
    { text: String(presentedColumn.taskCount) },
  ]);

  if (options.archivedTaskCount > 0) {
    rows.push([{ text: ARCHIVED_ROW_LABEL }, { text: String(options.archivedTaskCount) }]);
  }

  return formatRows(rows);
}
