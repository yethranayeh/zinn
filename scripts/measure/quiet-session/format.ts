/** Date, duration and estimate text used by the plan, the log and the status file. */

export function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function formatDateTime(date: Date): string {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatSessionId(date: Date): string {
  const day = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  return `${day}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatEstimate(minutes: number): string {
  if (minutes < 1) {
    return `${Math.round(minutes * 60)}s`;
  }
  if (minutes < 60) {
    return `${Math.round(minutes)} min`;
  }
  const wholeMinutes = Math.round(minutes);
  return `${Math.floor(wholeMinutes / 60)}h ${wholeMinutes % 60}m`;
}

/** Quotes one shell word for display and for a state file's manual undo line. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) {
    return word;
  }
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
