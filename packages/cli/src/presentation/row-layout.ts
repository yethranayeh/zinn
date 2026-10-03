import type { StyleFormat } from "./color";

import { styleOutputText } from "./color";

export type RowCell = { text: string; style?: StyleFormat };

const CELL_SEPARATOR = " | ";

export function formatCell(cell: RowCell, width = cell.text.length) {
  const paddedText = cell.text.padEnd(width);

  if (cell.style == null) {
    return paddedText;
  }

  return styleOutputText(cell.style, paddedText);
}

/**
 * Lines rows up by padding each cell's text to its column's **widest** text.
 * Widths use `String.length`, so emoji and CJK misalign.
 * A row's last cell holds free text such as a title and is left unpadded.
 */
export function formatRows(rows: Array<Array<RowCell>>) {
  const columnWidths: Array<number> = [];

  for (const row of rows) {
    row.forEach((cell, columnIndex) => {
      columnWidths[columnIndex] = Math.max(columnWidths[columnIndex] ?? 0, cell.text.length);
    });
  }

  return rows
    .map((row) => {
      const lastCellIndex = row.length - 1;

      return row
        .map((cell, columnIndex) => {
          if (columnIndex === lastCellIndex) {
            return formatCell(cell);
          }

          return formatCell(cell, columnWidths[columnIndex]!);
        })
        .join(CELL_SEPARATOR);
    })
    .join("\n");
}
