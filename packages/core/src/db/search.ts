import type { Task } from "../types.js";
import type { Database } from "../sqlite/database.js";

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { openDatabase } from "#sqlite";
import { getDb } from "../db.js";
import { DB_TABLE } from "../constant.js";
import { TASK_SEARCH_DEFINITION } from "../migrations/baseline.js";

export function addTask(entry: {
  taskId: string;
  title: string;
  description: string | null;
  comments: string;
}) {
  getDb()
    .query(`INSERT INTO ${DB_TABLE.taskSearch} (task_id, title, description, comments)
    VALUES ($taskId, $title, $description, $comments);`)
    .run({
      $taskId: entry.taskId,
      $title: entry.title,
      $description: entry.description,
      $comments: entry.comments,
    });
}

export function removeTask(taskId: string) {
  getDb()
    .query(`DELETE FROM ${DB_TABLE.taskSearch} WHERE task_id = $taskId;`)
    .run({ $taskId: taskId });
}

export function searchTasks(props: { match: string; projectId?: string }) {
  const bindings: Record<string, string> = { $match: props.match };
  let projectClause = "";

  if (props.projectId != null) {
    projectClause = `AND ${DB_TABLE.task}.project_id = $project_id`;
    bindings.$project_id = props.projectId;
  }

  return getDb()
    .query<Task & { project_key: string; search_rowid: number }, Record<string, string>>(`SELECT
      ${DB_TABLE.task}.*,
      ${DB_TABLE.project}.key AS project_key,
      ${DB_TABLE.taskSearch}.rowid AS search_rowid
    FROM ${DB_TABLE.taskSearch}
    INNER JOIN ${DB_TABLE.task} ON ${DB_TABLE.task}.id = ${DB_TABLE.taskSearch}.task_id
    INNER JOIN ${DB_TABLE.project} ON ${DB_TABLE.project}.id = ${DB_TABLE.task}.project_id
    WHERE ${DB_TABLE.taskSearch} MATCH $match
      ${projectClause}
    ORDER BY bm25(${DB_TABLE.taskSearch}, 0.0, 3.0, 1.0, 1.0) ASC,
      ${DB_TABLE.project}.key ASC,
      ${DB_TABLE.task}.number ASC`)
    .all(bindings);
}

type SearchHighlightRow = {
  rowid: number;
  task_id: string;
  title: string;
  description: string | null;
  comments: string;
  has_marker: number;
  has_nul: number;
  originalDescription?: string | null;
};

function readHighlights(database: Database, match: string, rowIds: number[], marker: string) {
  return database
    .query<SearchHighlightRow>(`SELECT rowid, task_id,
      highlight(${DB_TABLE.taskSearch}, 1, $marker, $marker) AS title,
      highlight(${DB_TABLE.taskSearch}, 2, $marker, $marker) AS description,
      highlight(${DB_TABLE.taskSearch}, 3, $marker, $marker) AS comments,
      instr(title, $marker) > 0 OR instr(coalesce(description, ''), $marker) > 0
        OR instr(comments, $marker) > 0 AS has_marker,
      instr(title, char(0)) > 0 OR instr(coalesce(description, ''), char(0)) > 0
        OR instr(comments, char(0)) > 0 AS has_nul
    FROM ${DB_TABLE.taskSearch}
    WHERE ${DB_TABLE.taskSearch} MATCH $match AND rowid IN (SELECT value FROM json_each($rowIds))`)
    .all({ $match: match, $rowIds: JSON.stringify(rowIds), $marker: marker });
}

function readHighlightsWithNul(
  database: Database,
  match: string,
  rowIds: number[],
  marker: string,
) {
  const sources = database
    .query<{
      rowid: number;
      task_id: string;
      title: Uint8Array;
      description: Uint8Array | null;
      comments: Uint8Array;
    }>(`SELECT rowid, task_id, CAST(title AS BLOB) AS title,
      CAST(description AS BLOB) AS description, CAST(comments AS BLOB) AS comments
    FROM ${DB_TABLE.taskSearch} WHERE rowid IN (SELECT value FROM json_each($rowIds))`)
    .all({ $rowIds: JSON.stringify(rowIds) });

  const scratch = openDatabase(":memory:");
  try {
    scratch.exec(TASK_SEARCH_DEFINITION);
    const insert = scratch.query(`INSERT INTO ${DB_TABLE.taskSearch}
      (rowid, task_id, title, description, comments) VALUES (?, ?, ?, ?, ?)`);
    // FTS5 can drop text after NUL when highlighting. Both characters delimit tokens without changing offsets.
    const replaceNul = (text: Uint8Array) =>
      Buffer.from(text).toString("utf8").replaceAll("\0", "\u0003");
    for (const source of sources) {
      insert.run(
        source.rowid,
        source.task_id,
        replaceNul(source.title),
        source.description === null ? null : replaceNul(source.description),
        replaceNul(source.comments),
      );
    }
    const originalDescriptions = new Map(
      sources.map((source) => [
        source.rowid,
        source.description === null ? null : Buffer.from(source.description).toString("utf8"),
      ]),
    );
    return readHighlights(scratch, match, rowIds, marker).map((row) => ({
      ...row,
      originalDescription: originalDescriptions.get(row.rowid)!,
    }));
  } finally {
    scratch.close();
  }
}

export function getTaskHighlights(match: string, rowIds: number[]) {
  const database = getDb();
  // The distinct end characters prevent a marker from overlapping an adjacent source character.
  const newMarker = () => `\u0001${randomUUID()}\u0002`;
  let marker = newMarker();
  let rows = readHighlights(database, match, rowIds, marker);
  while (rows.some((row) => row.has_marker)) {
    marker = newMarker();
    rows = readHighlights(database, match, rowIds, marker);
  }

  const nulRowIds = rows.filter((row) => row.has_nul).map((row) => row.rowid);
  if (nulRowIds.length > 0) {
    const recovered = readHighlightsWithNul(database, match, nulRowIds, marker);
    rows = [...rows.filter((row) => !row.has_nul), ...recovered];
  }
  return { marker, rows };
}
