/** The short timing table printed after a time run. */

const BYTES_PER_MEBIBYTE = 1_024 * 1_024;
const MILLISECONDS_PER_SECOND = 1_000;
const COMMAND_COLUMN_WIDTH = 10;
const TIME_COLUMN_WIDTH = 9;
const MEMORY_COLUMN_WIDTH = 10;
const BYTES_COLUMN_WIDTH = 13;

export type TimingTableRow = {
  command: string;
  p50WallSeconds: number;
  p95WallSeconds: number;
  medianPeakBytes: number;
  stdoutBytes: number;
};

export function formatTimingTable(
  tasks: number,
  fixtureName: string,
  rows: readonly TimingTableRow[],
): string[] {
  const lines = [`${tasks} tasks (${fixtureName})`];
  lines.push(
    [
      "command".padEnd(COMMAND_COLUMN_WIDTH),
      "p50 ms".padStart(TIME_COLUMN_WIDTH),
      "p95 ms".padStart(TIME_COLUMN_WIDTH),
      "peak MiB".padStart(MEMORY_COLUMN_WIDTH),
      "stdout bytes".padStart(BYTES_COLUMN_WIDTH),
    ].join(" "),
  );
  for (const row of rows) {
    lines.push(
      [
        row.command.padEnd(COMMAND_COLUMN_WIDTH),
        formatSecondsAsMilliseconds(row.p50WallSeconds).padStart(TIME_COLUMN_WIDTH),
        formatSecondsAsMilliseconds(row.p95WallSeconds).padStart(TIME_COLUMN_WIDTH),
        formatBytesAsMebibytes(row.medianPeakBytes).padStart(MEMORY_COLUMN_WIDTH),
        String(row.stdoutBytes).padStart(BYTES_COLUMN_WIDTH),
      ].join(" "),
    );
  }
  return lines;
}

function formatSecondsAsMilliseconds(seconds: number): string {
  return (seconds * MILLISECONDS_PER_SECOND).toFixed(1);
}

function formatBytesAsMebibytes(bytes: number): string {
  return (bytes / BYTES_PER_MEBIBYTE).toFixed(1);
}
