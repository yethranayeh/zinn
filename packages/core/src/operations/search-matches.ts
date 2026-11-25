import type { TaskWithKey } from "../types.js";

import * as dbComment from "../db/comment.js";
import * as dbSearch from "../db/search.js";
import { SEARCH_COMMENT_SEPARATOR } from "../search-entry.js";
import { attachCommentKey } from "./shared.js";

type Highlight = [start: number, end: number];

type Excerpt = {
  snippet: string;
  /** Zero-based, end-exclusive offsets in Unicode code points within the snippet. */
  highlights: Array<Highlight>;
};

export type TaskSearchMatch = Excerpt &
  ({ field: "key" | "title" | "description" } | { field: "comment"; comment_key: string });

const MAX_SNIPPET_LENGTH = 120;
const ELLIPSIS = "…";

/** Reads FTS markers into offsets in the original, unmarked text. */
function splitHighlights(markedText: string, marker: string) {
  const pieces = markedText.split(marker);
  const ranges: Array<Highlight> = [];
  let offset = 0;
  for (const [index, piece] of pieces.entries()) {
    const end = offset + piece.length;
    if (index % 2 === 1) {
      ranges.push([offset, end]);
    }
    offset = end;
  }
  return { text: pieces.join(""), ranges };
}

function makeExcerpt(text: string, sourceRanges: Array<Highlight>): Excerpt | null {
  if (sourceRanges.length === 0) {
    return null;
  }

  const points: Array<string> = [];
  const ranges: Array<Highlight> = [];
  let offset = 0;
  let rangeIndex = 0;
  let previousRange: Highlight | undefined;
  let pendingSpace = false;
  for (const point of text) {
    while (rangeIndex < sourceRanges.length && offset >= sourceRanges[rangeIndex]![1]) {
      rangeIndex++;
    }
    const range = sourceRanges[rangeIndex];
    const currentRange = range !== undefined && offset >= range[0] ? range : undefined;
    offset += point.length;
    if (/\s/u.test(point)) {
      pendingSpace = points.length > 0;
      continue;
    }
    if (pendingSpace) {
      points.push(" ");
      pendingSpace = false;
    }
    points.push(point);
    if (currentRange !== undefined) {
      if (currentRange === previousRange) {
        ranges.at(-1)![1] = points.length;
      } else {
        ranges.push([points.length - 1, points.length]);
      }
    }
    previousRange = currentRange;
  }

  const first = ranges[0];
  if (first === undefined) {
    return null;
  }
  if (points.length <= MAX_SNIPPET_LENGTH) {
    return { snippet: points.join(""), highlights: ranges };
  }

  // Leave one character for each ellipsis when choosing the context around the first hit.
  const context = Math.floor(Math.max(0, MAX_SNIPPET_LENGTH - 2 - (first[1] - first[0])) / 2);
  const start = Math.max(0, Math.min(first[0] - context, points.length - MAX_SNIPPET_LENGTH + 1));
  const prefix = start > 0 ? ELLIPSIS : "";
  const endWithoutSuffix = start + MAX_SNIPPET_LENGTH - prefix.length;
  const suffix = endWithoutSuffix < points.length ? ELLIPSIS : "";
  const end = Math.min(points.length, endWithoutSuffix - suffix.length);
  const highlights: Array<Highlight> = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    const visibleStart = Math.max(start, rangeStart);
    const visibleEnd = Math.min(end, rangeEnd);
    if (visibleStart < visibleEnd) {
      highlights.push([visibleStart - start + prefix.length, visibleEnd - start + prefix.length]);
    }
  }
  return { snippet: prefix + points.slice(start, end).join("") + suffix, highlights };
}

export function getSearchMatches(
  tasks: Array<TaskWithKey>,
  match: string,
  rowIdsByTaskId: ReadonlyMap<string, number>,
  pinnedTaskId: string | undefined,
) {
  const byTaskId = new Map<string, Array<TaskSearchMatch>>();
  const rowIds: number[] = [];
  for (const task of tasks) {
    byTaskId.set(
      task.id,
      task.id === pinnedTaskId
        ? [{ field: "key", snippet: task.key, highlights: [[0, task.key.length]] }]
        : [],
    );
    const rowId = rowIdsByTaskId.get(task.id);
    if (rowId !== undefined) {
      rowIds.push(rowId);
    }
  }
  if (rowIds.length === 0) {
    return byTaskId;
  }

  const { marker, rows } = dbSearch.getTaskHighlights(match, rowIds);
  const rowsByTaskId = new Map(rows.map((row) => [row.task_id, row]));
  const commentTaskIds = rows
    .filter((row) => row.comments.includes(marker))
    .map((row) => row.task_id);
  const comments =
    commentTaskIds.length === 0 ? [] : dbComment.getSearchSourcesByTaskIds(commentTaskIds);
  const commentsByTaskId = Map.groupBy(comments, (comment) => comment.task_id);

  for (const task of tasks) {
    const row = rowsByTaskId.get(task.id);
    if (row === undefined) {
      continue;
    }
    const matches = byTaskId.get(task.id)!;
    const title = splitHighlights(row.title, marker);
    const titleExcerpt = makeExcerpt(title.text, title.ranges);
    if (titleExcerpt !== null) {
      matches.push({ field: "title", ...titleExcerpt });
    }
    if (row.description !== null) {
      const description = splitHighlights(row.description, marker);
      const excerpt = makeExcerpt(row.originalDescription ?? description.text, description.ranges);
      if (excerpt !== null) {
        matches.push({ field: "description", ...excerpt });
      }
    }

    const { ranges } = splitHighlights(row.comments, marker);
    let start = 0;
    let rangeIndex = 0;
    // The separator can also occur in real text. Locate boundaries using the stored comments.
    for (const comment of commentsByTaskId.get(task.id) ?? []) {
      const end = start + comment.text.length;
      const commentRanges: Array<Highlight> = [];
      for (; rangeIndex < ranges.length; rangeIndex++) {
        const [rangeStart, rangeEnd] = ranges[rangeIndex]!;
        if (rangeStart >= end) {
          break;
        }
        if (rangeStart >= start && rangeEnd <= end) {
          commentRanges.push([rangeStart - start, rangeEnd - start]);
        }
      }
      const excerpt = makeExcerpt(comment.text, commentRanges);
      if (excerpt !== null) {
        matches.push({
          field: "comment",
          comment_key: attachCommentKey(comment, task.key).key,
          ...excerpt,
        });
      }
      start = end + SEARCH_COMMENT_SEPARATOR.length;
    }
  }

  return byTaskId;
}
