/** Block rows as recorded in blocks.tsv. */

export type BlockKind = "idle" | "work";

export type BlockRow = {
  round: number;
  label: string;
  kind: BlockKind;
  /** Unix seconds with milliseconds. */
  start: number;
  /** Unix seconds with milliseconds. */
  end: number;
  count: number;
};

export const BLOCK_COLUMNS = ["round", "label", "kind", "start", "end", "count"] as const;

export function formatBlockHeader(): string {
  return BLOCK_COLUMNS.join("\t");
}

export function formatBlockRow(row: BlockRow): string {
  return [
    String(row.round),
    row.label,
    row.kind,
    row.start.toFixed(3),
    row.end.toFixed(3),
    String(row.count),
  ].join("\t");
}

export function parseBlocks(text: string): BlockRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error("The block log is empty");
  }
  const header = lines[0]!.split("\t");
  if (header.join("\t") !== formatBlockHeader()) {
    throw new Error(`The block log header must be ${formatBlockHeader()}`);
  }
  const rows: BlockRow[] = [];
  for (let index = 1; index < lines.length; index++) {
    const cells = lines[index]!.split("\t");
    if (cells.length !== BLOCK_COLUMNS.length) {
      throw new Error(`Block log line ${index + 1} has ${cells.length} columns`);
    }
    const round = Number(cells[0]);
    const kind = cells[2];
    const start = Number(cells[3]);
    const end = Number(cells[4]);
    const count = Number(cells[5]);
    if (!Number.isInteger(round) || round < 1) {
      throw new Error(`Block log line ${index + 1} has no round number`);
    }
    if (kind !== "idle" && kind !== "work") {
      throw new Error(`Block log line ${index + 1} has kind ${kind}`);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error(`Block log line ${index + 1} has no valid window`);
    }
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Block log line ${index + 1} has no valid run count`);
    }
    rows.push({ round, label: cells[1]!, kind, start, end, count });
  }
  return rows;
}
