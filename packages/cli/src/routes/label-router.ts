import type { CommandInput, InputOption } from "../input.js";
import type { RouteDef } from "../types.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import {
  label,
  labelColorSchema,
  labelCreateSchema,
  labelDeleteSchema,
  labelEditSchema,
} from "@zinn-dev/core";

import { CliError } from "../errors.js";
import { generateCommandUsage, noInput } from "../input.js";
import {
  confirmationDescription,
  confirmAction,
  dashValueHelp,
  output,
  outputChanges,
  validatePositionals,
  validateUniqueOptions,
} from "../lib.js";
import {
  resolveTextEdit,
  textEditHelp,
  textEditOptions,
  textEditConstraints,
} from "../text-edit.js";
import {
  checkFieldsBeforeText,
  resolveTextInput,
  textFileHelp,
  textFileOption,
  textSourceConstraint,
} from "../text-input.js";
import { currentActor } from "../actor.js";
import { formatLabelList, presentLabel } from "../presentation/label-presentation.js";

const colorOption = {
  type: "string",
  value: {
    kind: "enum",
    name: "color",
    choices: labelColorSchema.options,
  },
} as const satisfies InputOption;

const labelInputs = {
  create: {
    options: {
      description: { type: "string", value: { kind: "text", name: "text" } },
      "description-file": textFileOption,
      color: colorOption,
    },
    forms: [
      { id: "default", positionals: [{ name: "name", min: 1, max: 1, value: { kind: "name" } }] },
    ],
    constraints: [textSourceConstraint("--description")],
  },
  list: noInput,
  view: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [{ name: "name", min: 1, max: 1, value: { kind: "label-name" } }],
      },
    ],
    constraints: [],
  },
  edit: {
    options: {
      name: { type: "string", value: { kind: "text", name: "text" } },
      description: { type: "string", value: { kind: "text", name: "text" } },
      "description-file": textFileOption,
      ...textEditOptions,
      color: colorOption,
    },
    forms: [
      { id: "default", positionals: [{ name: "name", min: 1, max: 1, value: { kind: "name" } }] },
    ],
    constraints: [
      textSourceConstraint("--description"),
      ...textEditConstraints("--description"),
      {
        kind: "atLeastOne",
        // A description can also come from --description-file
        members: Object.keys(labelEditSchema.shape)
          .filter((name) => name !== "labelName")
          .flatMap((name) =>
            name === "description"
              ? textSourceConstraint("--description").members
              : [`option:${name}` as const],
          ),
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
    run: async (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: labelInputs.create.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, labelInputs.create.options);
      validatePositionals(positionals, labelInputs.create.forms[0]);

      checkFieldsBeforeText(labelCreateSchema, { name: positionals[0], color: values.color });
      const description = await resolveTextInput(
        values.description,
        values["description-file"],
        "--description",
      );
      const input = labelCreateSchema.parse({
        name: positionals[0],
        description,
        color: values.color,
      });
      const created = label.create(input, currentActor());

      output(presentLabel(created), (entry) =>
        formatLabelList([entry], { showsDescriptionPreview: true }),
      );
    },
    help: `${generateCommandUsage("label create", labelInputs.create)}

Create a global label. Names preserve casing, but uniqueness is case-insensitive.
Names are trimmed and cannot be blank or contain line breaks or control characters.
Description is optional.
${textFileHelp("--description")}
The printed result is a preview. 'label view' and --json show the full text.

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

      output(label.getAll().map(presentLabel), (entries) =>
        formatLabelList(entries, { showsDescriptionPreview: true }),
      );
    },
    help: `${generateCommandUsage("label list", labelInputs.list)}

List all global label definitions.
Descriptions are previews.
Use label view <name> for the full description. --json keeps the full text.`,
  },
  view: {
    summary: "Show a global label with its full description.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: labelInputs.view,
    results: [jsonResult("Label")],
    run: (args) => {
      const { positionals } = parseArgs({
        args,
        options: labelInputs.view.options,
        strict: true,
        allowPositionals: true,
      });
      validatePositionals(positionals, labelInputs.view.forms[0]);

      const props = labelDeleteSchema.parse({ name: positionals[0] });
      const labelMatch = label.getByName(props.name);
      if (labelMatch == null) {
        throw new CliError(`A label with name "${props.name}" does not exist`, "not_found", {
          entity: "label",
          key: props.name,
          source: "explicit",
        });
      }

      output(presentLabel(labelMatch), (entry) => formatLabelList([entry]));
    },
    help: `${generateCommandUsage("label view", labelInputs.view)}

Show a global label with its full description, preserving line breaks and whitespace.
Label names are matched case-insensitively.

Example: zinn label view bug`,
  },
  edit: {
    summary: "Change specified fields.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: labelInputs.edit,
    results: [jsonResult("LabelChange")],
    run: async (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: labelInputs.edit.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, labelInputs.edit.options);
      validatePositionals(positionals, labelInputs.edit.forms[0]);

      checkFieldsBeforeText(labelEditSchema, {
        labelName: positionals[0],
        name: values.name,
        color: values.color,
      });
      const description = await resolveTextEdit(values, "--description");
      const input = labelEditSchema.parse({
        labelName: positionals[0],
        name: values.name,
        description,
        color: values.color,
      });
      const edited = label.edit(input, currentActor());

      outputChanges(
        [edited],
        (change) => presentLabel(change.label),
        (entries) => formatLabelList(entries, { showsDescriptionPreview: true }),
        (entry) => `Label "${entry.name}" was unchanged`,
      );
    },
    help: `${generateCommandUsage("label edit", labelInputs.edit)}

Change specified fields.
With --json, changed is false when all supplied values already match.
Provide at least one edit flag. Use --description '' to clear the description.
${textFileHelp("--description")}
Description echoes use a preview; label view and --json keep the full text.
Valid colors: ${labelInputs.edit.options.color.value.choices.join(", ")}.

${textEditHelp("--description")}

Label names match without case sensitivity.

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
