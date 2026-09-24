import type { CommentWithKey } from "@zinn-dev/core";
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

export function formatComment(commentMatch: PresentedComment) {
  const continuationIndent = " ".repeat(`${commentMatch.key} | `.length);
  const text = commentMatch.text.split(/\r?\n/).join(`\n${continuationIndent}`);
  return `${commentMatch.key} | ${text}`;
}

export function formatComments(comments: Array<PresentedComment>) {
  return comments.map(formatComment).join("\n");
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
      const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
      validatePositionalCount(positionals, 1, "Exactly one comment key is required");

      const commentMatch = comment.getByKey(positionals[0]!);
      const canDelete = confirmAction(`Are you sure you want to delete ${commentMatch.key}?`);
      const presented = presentComment(commentMatch);

      if (!canDelete) {
        output(presented, (entry) => `Deletion cancelled for ${entry.key}`);
        return;
      }

      comment.delete({ commentKey: commentMatch.key }, currentActor());
      output(presented, (entry) => `Deleted ${entry.key}`);
    },
    help: `Usage: zinn task comment delete <comment-key>

Permanently delete a comment after confirmation.

Example: zinn task comment delete MDR-1#2`,
  },
} satisfies RouteDef;
