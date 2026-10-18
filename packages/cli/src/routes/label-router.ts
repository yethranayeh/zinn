import type { PresentedLabel } from "../result-schemas.js";
import type { CommandInput, InputOption } from "../input.js";
import type { Label } from "@zinn-dev/core";
import type { RowCell } from "../presentation/row-layout.js";
import type { RouteDef } from "../types.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import { label, labelCreateSchema, labelDeleteSchema, labelEditSchema } from "@zinn-dev/core";

import { CliError } from "../errors.js";
import { generateCommandUsage, noInput } from "../input.js";
import {
  confirmationDescription,
  confirmAction,
  dashValueHelp,
  output,
  validatePositionals,
  validateUniqueOptions,
} from "../lib.js";
import {
  resolveTextEdit,
  textEditHelp,
  textEditOptions,
  textEditConstraints,
} from "../text-edit.js";
import { currentActor } from "../actor.js";
import { isColorEnabled } from "../presentation/color.js";
import { formatRows } from "../presentation/row-layout.js";

function presentLabel(labelMatch: Label): PresentedLabel {
  return { name: labelMatch.name, color: labelMatch.color, description: labelMatch.description };
}

function formatLabel(presented: PresentedLabel) {
  return formatLabelList([presented]);
}

function formatLabelList(presentedLabels: Array<PresentedLabel>) {
  return formatRows(
    presentedLabels.map((presented) => {
      const descriptionCells: Array<RowCell> =
        presented.description == null ? [] : [{ text: presented.description }];

      /**
       * The colored name shows the color, and if the environment
       *  does not support color, it is explicitly printed instead
       */
      if (isColorEnabled()) {
        return [{ text: presented.name, style: presented.color }, ...descriptionCells];
      }

      return [{ text: presented.name }, { text: presented.color }, ...descriptionCells];
    }),
  );
}

const colorOption = {
  type: "string",
  value: {
    kind: "enum",
    name: "color",
    choices: labelCreateSchema.shape.color.unwrap().options,
  },
} as const satisfies InputOption;

const labelInputs = {
  create: {
    options: {
      description: { type: "string", value: { kind: "text", name: "text" } },
      color: colorOption,
    },
    forms: [
      { id: "default", positionals: [{ name: "name", min: 1, max: 1, value: { kind: "name" } }] },
    ],
    constraints: [],
  },
  list: noInput,
  edit: {
    options: {
      name: { type: "string", value: { kind: "text", name: "text" } },
      description: { type: "string", value: { kind: "text", name: "text" } },
      ...textEditOptions,
      color: colorOption,
    },
    forms: [
      { id: "default", positionals: [{ name: "name", min: 1, max: 1, value: { kind: "name" } }] },
    ],
    constraints: [
      ...textEditConstraints("--description"),
      {
        kind: "atLeastOne",
        members: Object.keys(labelEditSchema.shape)
          .filter((name) => name !== "labelName")
          .map((name) => `option:${name}` as const),
      },
    ],
    notes: [textEditHelp("--description")],
  },
  delete: {
    options: { yes: { type: "boolean" } },
    forms: [
      { id: "default", positionals: [{ name: "name", min: 1, max: 1, value: { kind: "name" } }] },
    ],
    constraints: [],
  },
} as const satisfies Record<string, CommandInput>;

export const labelRouter = {
  create: {
    summary: "Create a global label. Names preserve casing, but uniqueness is case-insensitive.",
    effects: { domain: "create", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: labelInputs.create,
    results: [jsonResult("Label")],
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: labelInputs.create.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, labelInputs.create.options);
      validatePositionals(positionals, labelInputs.create.forms[0]);

      const input = labelCreateSchema.parse({ name: positionals[0], ...values });
      const created = label.create(input, currentActor());

      output(presentLabel(created), formatLabel);
    },
    help: `${generateCommandUsage("label create", labelInputs.create)}

Create a global label. Names preserve casing, but uniqueness is case-insensitive.
Names are trimmed and cannot be blank or contain line breaks or control characters.
Description is optional.

Color defaults to white.
Valid colors: ${labelInputs.create.options.color.value.choices.join(", ")}.

${dashValueHelp("--description")}

Example: zinn label create bug --description 'Unexpected behavior' --color red`,
  },
  list: {
    summary: "List all global label definitions.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: labelInputs.list,
    results: [jsonResult("LabelList")],
    run: (args) => {
      const { positionals } = parseArgs({
        options: labelInputs.list.options,
        args,
        strict: true,
        allowPositionals: true,
      });
      validatePositionals(positionals, labelInputs.list.forms[0]);

      output(label.getAll().map(presentLabel), formatLabelList);
    },
    help: `${generateCommandUsage("label list", labelInputs.list)}

List all global label definitions.`,
  },
  edit: {
    summary: "Change specified fields.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: labelInputs.edit,
    results: [jsonResult("Label")],
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: labelInputs.edit.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, labelInputs.edit.options);
      validatePositionals(positionals, labelInputs.edit.forms[0]);

      const input = labelEditSchema.parse({
        labelName: positionals[0],
        name: values.name,
        description: resolveTextEdit(values.description, values, "--description"),
        color: values.color,
      });
      const edited = label.edit(input, currentActor());

      output(presentLabel(edited), formatLabel);
    },
    help: `${generateCommandUsage("label edit", labelInputs.edit)}

Change specified fields.
Provide at least one edit flag. Use --description '' to clear the description.
Valid colors: ${labelInputs.edit.options.color.value.choices.join(", ")}.

${textEditHelp("--description")}

Names are matched and kept unique case-insensitively while preserving their casing.
Names are trimmed. Changing only the casing is allowed.
Editing does not affect task attachments or task timestamps.

${dashValueHelp("--description")}

Examples:
  zinn label edit bug --name defect --color yellow
  zinn label edit bug --description 'Reported by users.' --append`,
  },
  delete: {
    summary: "Delete a label definition and remove it from all tasks after confirmation.",
    effects: { domain: "delete", storage: "normal-open" },
    confirmation: { kind: "prompt", description: confirmationDescription },
    input: labelInputs.delete,
    results: [jsonResult("Label")],
    run: async (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: labelInputs.delete.options,
        strict: true,
        allowPositionals: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, labelInputs.delete.options);
      validatePositionals(positionals, labelInputs.delete.forms[0]);

      const props = labelDeleteSchema.parse({ name: positionals[0] });
      const labelMatch = label.getByName(props.name);

      if (labelMatch == null) {
        throw new CliError(`A label with name "${props.name}" does not exist`, "not_found", {
          entity: "label",
          key: props.name,
          source: "explicit",
        });
      }

      const canDelete = await confirmAction(
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
    help: `${generateCommandUsage("label delete", labelInputs.delete)}

Delete a label definition and remove it from all tasks after confirmation.
To remove a label from just one task, use zinn task label remove.
Label names are matched case-insensitively.

Use --yes to skip the confirmation prompt, for example in scripts or with --json.`,
  },
} satisfies RouteDef;
