import type { CommentWithKey } from "@zinn-dev/core";
import type { RowCell } from "../presentation/row-layout";
import type { RouteDef } from "../types";

import { parseArgs } from "node:util";
import { comment } from "@zinn-dev/core";

import {
  confirmAction,
  output,
  quit,
  validatePositionalCount,
  validateUniqueOptions,
} from "../lib";
import { currentActor } from "../actor";
import { formatRows } from "../presentation/row-layout";

type PresentedComment = Pick<CommentWithKey, "key" | "text" | "created_at" | "updated_at">;

function presentComment(commentMatch: CommentWithKey): PresentedComment {
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

function formatCommentCreatedAt(createdAt: number) {
  const date = new Date(createdAt);
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const remainingOffsetMinutes = absoluteOffsetMinutes % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())} ` +
    `${offsetSign}${pad(offsetHours)}:${pad(remainingOffsetMinutes)}`
  );
}

function commentRow(commentMatch: PresentedComment, options: { showsCreatedAt: boolean }) {
  const createdAtCells: Array<RowCell> = options.showsCreatedAt
    ? [{ text: formatCommentCreatedAt(commentMatch.created_at) }]
    : [];

  return [{ text: commentMatch.key }, ...createdAtCells, { text: commentMatch.text }];
}

export function formatComment(commentMatch: PresentedComment) {
  return formatRows([commentRow(commentMatch, { showsCreatedAt: false })], {
    indentsContinuationLines: true,
  });
}

export function formatComments(comments: Array<PresentedComment>) {
  return formatRows(
    comments.map((commentMatch) => commentRow(commentMatch, { showsCreatedAt: true })),
    { indentsContinuationLines: true },
  );
}

function parseTextArgs(args: Array<string>, entityName: "task" | "comment") {
  const { values, positionals, tokens } = parseArgs({
    args,
    options: { text: { type: "string" } },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  validatePositionalCount(positionals, 1, `Exactly one ${entityName} key is required`);
  validateUniqueOptions(tokens);

  if (values.text === undefined) {
    quit("Comment text must be specified with --text");
  }

  return { key: positionals[0]!, text: values.text };
}

export const commentRouter = {
  create: {
    run: (args) => {
      const props = parseTextArgs(args, "task");
      const created = comment.create({ taskKey: props.key, text: props.text }, currentActor());
      output(presentComment(created), formatComment);
    },
    help: `Usage: zinn task comment create <task-key> --text <text>

Add a comment to a task. Comment text cannot be blank.
Archived tasks can be commented on.

Example: zinn task comment create MDR-1 --text "Ready for review"`,
  },
  list: {
    run: (args) => {
      const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
      validatePositionalCount(positionals, 1, "Exactly one task key is required");
      output(presentComments(positionals[0]!), formatComments);
    },
    help: `Usage: zinn task comment list <task-key>

List a task's comments by oldest first.

Example: zinn task comment list MDR-1`,
  },
  edit: {
    run: (args) => {
      const props = parseTextArgs(args, "comment");
      const edited = comment.edit({ commentKey: props.key, text: props.text }, currentActor());
      output(presentComment(edited), formatComment);
    },
    help: `Usage: zinn task comment edit <comment-key> --text <text>

Replace a comment's text. Comment text cannot be blank.

Example: zinn task comment edit MDR-1#2 --text "Approved"`,
  },
  delete: {
    run: (args) => {
      const { values, positionals } = parseArgs({
        args,
        options: { yes: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      });
      validatePositionalCount(positionals, 1, "Exactly one comment key is required");

      const commentMatch = comment.getByKey(positionals[0]!);
      const canDelete = confirmAction(
        `Are you sure you want to delete ${commentMatch.key}?`,
        values.yes === true,
      );
      const presented = presentComment(commentMatch);

      if (!canDelete) {
        output(presented, (entry) => `Deletion cancelled for ${entry.key}`);
        return;
      }

      comment.delete({ commentKey: commentMatch.key }, currentActor());
      output(presented, (entry) => `Deleted ${entry.key}`);
    },
    help: `Usage: zinn task comment delete <comment-key> [--yes]

Permanently delete a comment after confirmation.
Use --yes to skip the confirmation prompt, for example in scripts or with --json.

Example: zinn task comment delete MDR-1#2`,
  },
} satisfies RouteDef;
