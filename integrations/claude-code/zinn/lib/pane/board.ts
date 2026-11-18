// One board (`zinn project view KEY --json` for the columns in their order, plus
// `zinn task list KEY --json` for the active tasks) and the list of boards (`zinn project list --json`),
// reduced to what the pane draws. Pure: nothing here imports the engine module.
import { categoryOf, isClosed, type Category } from "../columns";
import { num, str, strings } from "./task";

export type BoardTask = {
  key: string;
  title: string;
  priority: string;
  labels: Array<string>;
  dueAt: number | null;
  updatedAt: number | null;
};

export type BoardColumn = {
  name: string;
  /** Null when the store gives none the mod knows. */
  category: Category | null;
  isFirst: boolean;
  isLast: boolean;
  /** In board order, as the CLI lists them. */
  tasks: Array<BoardTask>;
};

export type BoardView = {
  key: string;
  name: string;
  columns: Array<BoardColumn>;
  archivedCount: number;
};

export type ProjectRow = { key: string; name: string; active: number; archived: number };

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Joins the two answers. The project gives the columns in their order (an empty column is still a column). * the list gives the tasks. A task in a column the project does not name gets a column of its own at the
 * end, so nothing the CLI listed is dropped. Throws a short reason on anything that is not a board.
 */
export function parseBoard(projectStdout: string, tasksStdout: string): BoardView {
  const p = obj(JSON.parse(projectStdout));
  if (p === null || typeof p["key"] !== "string") {
    throw new Error("expected a project");
  }
  const rows: unknown = JSON.parse(tasksStdout);
  if (!Array.isArray(rows)) {
    throw new Error("expected a JSON array of tasks");
  }
  const columns: Array<BoardColumn> = [];
  const byName = new Map<string, BoardColumn>();
  for (const x of Array.isArray(p["columns"]) ? (p["columns"] as unknown[]) : []) {
    const c = obj(x);
    if (c === null || typeof c["name"] !== "string") {
      continue;
    }
    const col: BoardColumn = {
      name: c["name"],
      category: categoryOf(c["category"]),
      isFirst: c["is_first"] === true,
      isLast: c["is_last"] === true,
      tasks: [],
    };
    columns.push(col);
    byName.set(col.name, col);
  }
  for (const x of rows as unknown[]) {
    const t = obj(x);
    if (t === null || typeof t["key"] !== "string" || t["status"] === "Archived") {
      continue;
    }
    const name = str(t["column"]);
    let col = byName.get(name);
    if (col === undefined) {
      col = { name, category: categoryOf(t["column_category"]), isFirst: t["is_first"] === true, isLast: t["is_last"] === true, tasks: [] };
      columns.push(col);
      byName.set(name, col);
    }
    col.tasks.push({
      key: t["key"],
      title: str(t["title"]),
      priority: str(t["priority"]),
      labels: strings(t["labels"]),
      dueAt: num(t["due_at"]),
      updatedAt: num(t["updated_at"]),
    });
  }
  return {
    key: p["key"],
    name: str(p["name"]),
    columns,
    archivedCount: num(p["archivedTaskCount"]) ?? 0,
  };
}

/** Parses `zinn project list --json`. Throws a short reason on anything that is not a list. */
export function parseProjects(stdout: string): ProjectRow[] {
  const d: unknown = JSON.parse(stdout);
  if (!Array.isArray(d)) {
    throw new Error("expected a JSON array of projects");
  }
  const out: ProjectRow[] = [];
  for (const x of d as unknown[]) {
    const p = obj(x);
    if (p === null || typeof p["key"] !== "string") {
      continue;
    }
    const counts = obj(p["taskCounts"]) ?? {};
    out.push({
      key: p["key"],
      name: str(p["name"]),
      active: num(counts["active"]) ?? 0,
      archived: num(counts["archived"]) ?? 0,
    });
  }
  return out;
}

export const openCount = (b: BoardView): number =>
  b.columns.reduce((n, c) => n + (isClosed(c) ? 0 : c.tasks.length), 0);
/** Tasks in done or cancelled columns (lib/columns.ts isClosed). */
export const closedCount = (b: BoardView): number =>
  b.columns.reduce((n, c) => n + (isClosed(c) ? c.tasks.length : 0), 0);
