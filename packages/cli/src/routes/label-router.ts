import type { Label } from "@zinn-dev/core";
import type { RouteDef } from "../types";

import { parseArgs, styleText } from "node:util";
import { label, labelCreateSchema, labelDeleteSchema, labelEditSchema } from "@zinn-dev/core";

import {
  confirmAction,
  output,
  quit,
  validatePositionalCount,
  validateUniqueOptions,
} from "../lib";
import { currentActor } from "../actor";

type PresentedLabel = Omit<Label, "id">;

function presentLabel(labelMatch: Label): PresentedLabel {
  return { name: labelMatch.name, color: labelMatch.color, description: labelMatch.description };
}

function formatLabel(presented: PresentedLabel) {
  const coloredName = styleText(presented.color, presented.name);

  if (presented.description.length === 0) {
    return coloredName;
  }

  return `${coloredName} | ${presented.description}`;
}

export const labelRouter = {
  create: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { description: { type: "string" }, color: { type: "string" } },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validatePositionalCount(positionals, 1, "Exactly one label name is required");

      validateUniqueOptions(tokens);

      const input = labelCreateSchema.parse({ name: positionals[0], ...values });
      const created = label.create(input, currentActor());

      output(presentLabel(created), formatLabel);
    },
    help: `Usage: zinn label create <name> [--description <text>] [--color <color>]

Create a global label. Names preserve casing, but uniqueness is case-insensitive.
Names are trimmed and cannot be blank.
Description defaults to an empty string; color defaults to white.
Colors: red, green, yellow, blue, magenta, cyan, white, gray.

Example: zinn label create bug --description "Unexpected behavior" --color red`,
  },
  list: {
    run: (args) => {
      parseArgs({ args, strict: true, allowPositionals: false });
      output(label.getAll().map(presentLabel), (labels) => labels.map(formatLabel).join("\n"));
    },
    help: `Usage: zinn label list

List all global label definitions.`,
  },
  edit: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: {
          name: { type: "string" },
          description: { type: "string" },
          color: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validatePositionalCount(positionals, 1, "Exactly one label name is required");
      validateUniqueOptions(tokens);

      const input = labelEditSchema.parse({ labelName: positionals[0], ...values });
      const edited = label.edit(input, currentActor());

      output(presentLabel(edited), formatLabel);
    },
    help: `Usage: zinn label edit <name> [--name <text>] [--description <text>] [--color <color>]

Change specified fields.
Provide at least one edit flag. Use --description "" for an empty description.

Names are matched and kept unique case-insensitively while preserving their casing.
Names are trimmed. Changing only the casing is allowed.
Editing does not affect task attachments or task timestamps.

Example: zinn label edit bug --name defect --color yellow`,
  },
  delete: {
    run: (args) => {
      const { values, positionals } = parseArgs({
        args,
        options: { yes: { type: "boolean" } },
        strict: true,
        allowPositionals: true,
      });

      validatePositionalCount(positionals, 1, "Exactly one label name is required");

      const props = labelDeleteSchema.parse({ name: positionals[0] });
      const labelMatch = label.getByName(props.name);

      if (labelMatch == null) {
        quit(`A label with name "${props.name}" does not exist`);
      }

      const canDelete = confirmAction(
        `Are you sure you want to delete label "${labelMatch.name}" and remove it from all tasks?`,
        values.yes === true,
      );

      if (!canDelete) {
        output(presentLabel(labelMatch), (l) => `Deletion cancelled for label "${l.name}"`);
        return;
      }

      const deleted = label.delete(props, currentActor());
      output(presentLabel(deleted), (l) => `Deleted label "${l.name}"`);
    },
    help: `Usage: zinn label delete <name> [--yes]

Delete a label definition and remove it from all tasks after confirmation.
To remove a label from just one task, use zinn task label remove.
Label names are matched case-insensitively.

Use --yes to skip the confirmation prompt, for example in scripts or with --json.`,
  },
} satisfies RouteDef;
