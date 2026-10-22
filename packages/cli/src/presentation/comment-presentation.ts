import type { CommentWithKey } from "@zinn-dev/core";
import type { PresentedComment } from "../result-schemas.js";
import type { RowCell } from "./row-layout.js";

import { comment } from "@zinn-dev/core";

import { formatDescriptionPreview } from "./description-presentation.js";
import { formatRows } from "./row-layout.js";
import { formatLocalTime } from "./time.js";

export function presentComment(commentMatch: CommentWithKey): PresentedComment {
  return {
    key: commentMatch.key,
    text: commentMatch.text,
    created_at: commentMatch.created_at,
    updated_at: commentMatch.updated_at,
  };
}

export function presentComments(taskKey: string) {
  return comment.getAll(taskKey).map(presentComment);
}

function commentRow(
  commentMatch: PresentedComment,
  options: { showsCreatedAt: boolean; showsTextPreview?: boolean },
) {
  const createdAtCells: Array<RowCell> = options.showsCreatedAt
    ? [{ text: formatLocalTime(commentMatch.created_at), style: "dim" }]
    : [];

  const text = options.showsTextPreview
    ? formatDescriptionPreview(commentMatch.text, { firstLineOnly: true })
    : commentMatch.text;

  return [{ text: commentMatch.key }, ...createdAtCells, { text }];
}

export function formatCommentList(
  comments: Array<PresentedComment>,
  { showsCreatedAt = true, showsTextPreview = false } = {},
) {
  return formatRows(
    comments.map((commentMatch) => commentRow(commentMatch, { showsCreatedAt, showsTextPreview })),
    { indentsContinuationLines: true },
  );
}
