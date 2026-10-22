import type { CommandInput } from "../input.js";
import type { RouteDef } from "../types.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import { comment } from "@zinn-dev/core";

import { generateCommandUsage, taskKeyPositional } from "../input.js";
import {
  confirmationDescription,
  confirmAction,
  dashValueHelp,
  output,
  validatePositionals,
  requireStringOption,
  validateUniqueOptions,
} from "../lib.js";
import {
  resolveTextEdit,
  textEditHelp,
  textEditOptions,
  textEditConstraints,
} from "../text-edit.js";
import { currentActor } from "../actor.js";
import {
  formatCommentList,
  presentComment,
  presentComments,
} from "../presentation/comment-presentation.js";

function parseTextArgs(args: Array<string>) {
  const { values, positionals, tokens } = parseArgs({
    args,
    options: commentInputs.create.options,
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  validateUniqueOptions(tokens, commentInputs.create.options);
  validatePositionals(positionals, commentInputs.create.forms[0]);

  const text = requireStringOption(
    commentInputs.create.options.text,
    values.text,
    "text",
    "Comment text must be specified with --text",
  );

  return { key: positionals[0]!, text };
}

function parseCommentEditArgs(args: Array<string>) {
  const { values, positionals, tokens } = parseArgs({
    args,
    options: commentInputs.edit.options,
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  validateUniqueOptions(tokens, commentInputs.edit.options);
  validatePositionals(positionals, commentInputs.edit.forms[0]);

  const text = resolveTextEdit(values.text, values, "--text");
  requireStringOption(
    commentInputs.edit.options.text,
    values.text,
    "text",
    "Comment text must be specified with --text",
  );

  return { key: positionals[0]!, text: text! };
}

const commentInputs = {
  create: {
    options: { text: { type: "string", required: true, value: { kind: "text", name: "text" } } },
    forms: [
      {
        id: "default",
        positionals: [taskKeyPositional],
      },
    ],
    constraints: [],
  },
  list: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [taskKeyPositional],
      },
    ],
    constraints: [],
  },
  view: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [{ name: "comment-key", min: 1, max: 1, value: { kind: "comment-key" } }],
      },
    ],
    constraints: [],
  },
  edit: {
    options: {
      text: { type: "string", required: true, value: { kind: "text", name: "text" } },
      ...textEditOptions,
    },
    forms: [
      {
        id: "default",
        positionals: [{ name: "comment-key", min: 1, max: 1, value: { kind: "comment-key" } }],
      },
    ],
    constraints: [...textEditConstraints("--text")],
    notes: [textEditHelp("--text")],
  },
  delete: {
    options: { yes: { type: "boolean" } },
    forms: [
      {
        id: "default",
        positionals: [{ name: "comment-key", min: 1, max: 1, value: { kind: "comment-key" } }],
      },
    ],
    constraints: [],
  },
} as const satisfies Record<string, CommandInput>;

export const commentRouter = {
  create: {
    summary: "Add a comment to a task. Comment text cannot be blank.",
    effects: { domain: "create", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: commentInputs.create,
    results: [jsonResult("Comment")],
    run: (args) => {
      const props = parseTextArgs(args);
      const created = comment.create({ taskKey: props.key, text: props.text }, currentActor());
      output(presentComment(created), (entry) =>
        formatCommentList([entry], { showsCreatedAt: false, showsTextPreview: true }),
      );
    },
    help: `${generateCommandUsage("task comment create", commentInputs.create)}

Add a comment to a task. Comment text cannot be blank.
Archived tasks can be commented on.
The printed result is a preview. 'task comment view' shows the full text. --json keeps the full text.

${dashValueHelp("--text")}

Example: zinn task comment create MDR-1 --text 'Ready for review'`,
  },
  list: {
    summary: "List a task's comments by oldest first.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: commentInputs.list,
    results: [jsonResult("CommentList")],
    run: (args) => {
      const { positionals } = parseArgs({
        options: commentInputs.list.options,
        args,
        allowPositionals: true,
        strict: true,
      });
      validatePositionals(positionals, commentInputs.list.forms[0]);
      output(presentComments(positionals[0]!), formatCommentList);
    },
    help: `${generateCommandUsage("task comment list", commentInputs.list)}

List a task's comments by oldest first.

Example: zinn task comment list MDR-1`,
  },
  view: {
    summary: "Show a comment's current text in full, keeping its line breaks.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: commentInputs.view,
    results: [jsonResult("Comment")],
    run: (args) => {
      const { positionals } = parseArgs({
        options: commentInputs.view.options,
        args,
        allowPositionals: true,
        strict: true,
      });
      validatePositionals(positionals, commentInputs.view.forms[0]);
      output(presentComment(comment.getByKey(positionals[0]!)), (entry) =>
        formatCommentList([entry], { showsCreatedAt: false }),
      );
    },
    help: `${generateCommandUsage("task comment view", commentInputs.view)}

Show a comment's current text in full, keeping its line breaks.
Comments on archived tasks can be viewed.
With --json, return one object with key, text, created_at and updated_at.

Example: zinn task comment view 'MDR-1#1'`,
  },
  edit: {
    summary: "Replace a comment's text. Comment text cannot be blank.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: commentInputs.edit,
    results: [jsonResult("Comment")],
    run: (args) => {
      const props = parseCommentEditArgs(args);
      const edited = comment.edit({ commentKey: props.key, text: props.text }, currentActor());
      output(presentComment(edited), (entry) =>
        formatCommentList([entry], { showsCreatedAt: false, showsTextPreview: true }),
      );
    },
    help: `${generateCommandUsage("task comment edit", commentInputs.edit)}

Replace a comment's text. Comment text cannot be blank.
The printed result is a preview. 'task comment view' shows the full text. --json keeps the full text.

${textEditHelp("--text")}

${dashValueHelp("--text")}

Examples:
  zinn task comment edit 'MDR-1#2' --text Approved
  zinn task comment edit 'MDR-1#2' --text 'Also approved.' --append`,
  },
  delete: {
    summary: "Permanently delete a comment after confirmation.",
    effects: { domain: "delete", storage: "normal-open" },
    confirmation: { kind: "prompt", description: confirmationDescription },
    input: commentInputs.delete,
    results: [jsonResult("Comment")],
    run: async (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: commentInputs.delete.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens, commentInputs.delete.options);
      validatePositionals(positionals, commentInputs.delete.forms[0]);

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
    help: `${generateCommandUsage("task comment delete", commentInputs.delete)}

Permanently delete a comment after confirmation.
Use --yes to skip the confirmation prompt, for example in scripts or with --json.

Example: zinn task comment delete 'MDR-1#2'`,
  },
} satisfies RouteDef;
