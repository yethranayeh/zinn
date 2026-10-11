import type { CommentWithKey } from "@zinn-dev/core";
import type { RowCell } from "../presentation/row-layout";
import type { RouteDef } from "../types";

import { parseArgs } from "node:util";
import { comment } from "@zinn-dev/core";

import {
  confirmAction,
  output,
  quit,
  validatePositionals,
  validateUniqueOptions,
} from "../lib";
import { resolveTextEdit, textEditHelp, textEditOptions, textEditUsage } from "../text-edit";
import { currentActor } from "../actor";
import { formatRows } from "../presentation/row-layout";
import { formatLocalTime } from "../presentation/time";

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

function commentRow(commentMatch: PresentedComment, options: { showsCreatedAt: boolean }) {
  const createdAtCells: Array<RowCell> = options.showsCreatedAt
    ? [{ text: formatLocalTime(commentMatch.created_at), style: "dim" }]
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

function parseTextArgs(args: Array<string>) {
  const { values, positionals, tokens } = parseArgs({
    args,
    options: { text: { type: "string" } },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  validateUniqueOptions(tokens);
  validatePositionals(positionals, ["<task-key>"]);

  if (values.text === undefined) {
    quit("Comment text must be specified with --text");
  }

  return { key: positionals[0]!, text: values.text };
}

function parseCommentEditArgs(args: Array<string>) {
  const { values, positionals, tokens } = parseArgs({
    args,
    options: { text: { type: "string" }, ...textEditOptions },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  validateUniqueOptions(tokens);
  validatePositionals(positionals, ["<comment-key>"]);

  const text = resolveTextEdit(values.text, values, "--text");
  if (text === undefined) {
    quit("Comment text must be specified with --text");
  }

  return { key: positionals[0]!, text };
}

export const commentRouter = {
  create: {
    run: (args) => {
      const props = parseTextArgs(args);
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
      validatePositionals(positionals, ["<task-key>"]);
      output(presentComments(positionals[0]!), formatComments);
    },
    help: `Usage: zinn task comment list <task-key>

List a task's comments by oldest first.

Example: zinn task comment list MDR-1`,
  },
  edit: {
    run: (args) => {
      const props = parseCommentEditArgs(args);
      const edited = comment.edit({ commentKey: props.key, text: props.text }, currentActor());
      output(presentComment(edited), formatComment);
    },
    help: `Usage: zinn task comment edit <comment-key> --text <text> ${textEditUsage}

Replace a comment's text. Comment text cannot be blank.

${textEditHelp("--text")}

Examples:
  zinn task comment edit MDR-1#2 --text "Approved"
  zinn task comment edit MDR-1#2 --text "Also approved." --append`,
  },
  delete: {
    run: async (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { yes: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens);
      validatePositionals(positionals, ["<comment-key>"]);

      const commentMatch = comment.getByKey(positionals[0]!);
      const canDelete = await confirmAction(
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
