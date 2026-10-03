import type { StyleFormat } from "./color";

import { styleOutputText } from "./color";

export type RowCell = { text: string; style?: StyleFormat };

const CELL_SEPARATOR = " | ";
const LINE_BREAK_PATTERN = /\r?\n/;

export function formatCell(cell: RowCell, width = cell.text.length) {
  const paddedText = cell.text.padEnd(width);

  if (cell.style == null) {
    return paddedText;
  }

  return styleOutputText(cell.style, paddedText);
}

function indentContinuationLines(text: string, indentWidth: number) {
  return text.split(LINE_BREAK_PATTERN).join(`\n${" ".repeat(indentWidth)}`);
}

/**
 * Lines rows up by padding each cell's text to its column's **widest** text.
 * Widths use `String.length`, so emoji and CJK misalign.
 * A row's last cell holds free text such as a title and is left unpadded.
 *
 * With `indentsContinuationLines`, a last cell that spans several lines starts each later line
 *  where the cell starts, below the padded cells before it. Without it, those lines are left as they are.
 * Only a last cell may span lines: the widths do not account for line breaks.
 */
export function formatRows(
  rows: Array<Array<RowCell>>,
  options: { indentsContinuationLines?: boolean } = {},
) {
  const columnWidths: Array<number> = [];

  for (const row of rows) {
    row.forEach((cell, columnIndex) => {
      columnWidths[columnIndex] = Math.max(columnWidths[columnIndex] ?? 0, cell.text.length);
    });
  }

  return rows
    .map((row) => {
      const lastCellIndex = row.length - 1;
      const lastCellStartColumn = columnWidths
        .slice(0, lastCellIndex)
        .reduce((total, width) => total + width + CELL_SEPARATOR.length, 0);

      return row
        .map((cell, columnIndex) => {
          if (columnIndex !== lastCellIndex) {
            return formatCell(cell, columnWidths[columnIndex]!);
          }

          if (!options.indentsContinuationLines) {
            return formatCell(cell);
          }

          return formatCell({
            ...cell,
            text: indentContinuationLines(cell.text, lastCellStartColumn),
          });
        })
        .join(CELL_SEPARATOR);
    })
    .join("\n");
}
