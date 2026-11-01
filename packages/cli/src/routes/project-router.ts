import type { RouteDef } from "../types.js";
import type { CommandInput, InputConstraint } from "../input.js";
import type { PresentedProjectView, PresentedProjectListEntry } from "../result-schemas.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import {
  column,
  project,
  columnOrderSchema,
  columnDeleteSchema,
  projectCreateSchema,
  projectEditSchema,
} from "@zinn-dev/core";

import { CliError } from "../errors.js";
import { generateCommandUsage, getOptionInputs, noInput, violatesConstraint } from "../input.js";
import {
  confirmationDescription,
  canPrompt,
  confirmAction,
  dashValueHelp,
  diagnostic,
  output,
  outputChanges,
  quit,
  validatePositionals,
  validateOrderForms,
  requireStringOption,
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
import {
  formatColumnList,
  presentColumn,
  presentColumnTaskCounts,
} from "../presentation/column-presentation.js";
import { formatProjectList, presentProject } from "../presentation/project-presentation.js";
import { formatSection } from "../presentation/section.js";
import { currentActor } from "../actor.js";
import {
  checkDefaultProject,
  chooseProjectKey,
  resolveProjectKey,
  requiredProjectDescription,
} from "../project.js";

const projectEditConstraint = {
  kind: "atLeastOne",
  members: ["option:name", "option:description", "option:description-file"],
} as const satisfies InputConstraint;

const projectInputs = {
  create: {
    options: {
      name: { type: "string", value: { kind: "text", name: "text" } },
      description: { type: "string", value: { kind: "text", name: "text" } },
      "description-file": textFileOption,
    },
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 1, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [textSourceConstraint("--description")],
  },
  list: noInput,
  view: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 0, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [],
    notes: [requiredProjectDescription],
  },
  edit: {
    options: {
      name: { type: "string", value: { kind: "text", name: "text" } },
      description: { type: "string", value: { kind: "text", name: "text" } },
      "description-file": textFileOption,
      ...textEditOptions,
    },
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 0, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [
      textSourceConstraint("--description"),
      ...textEditConstraints("--description"),
      projectEditConstraint,
    ],
    notes: [requiredProjectDescription, textEditHelp("--description")],
  },
  delete: {
    options: { yes: { type: "boolean" } },
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 0, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [],
    notes: [requiredProjectDescription],
  },
  column_create: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [
          { name: "project-key", min: 1, max: 1, value: { kind: "project-key" } },
          { name: "column-name", min: 1, max: 1, value: { kind: "column-name" } },
        ],
      },
    ],
    constraints: [],
  },
  column_list: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 0, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [],
    notes: [requiredProjectDescription],
  },
  column_edit: {
    options: { name: { type: "string", required: true, value: { kind: "text", name: "text" } } },
    forms: [
      {
        id: "default",
        positionals: [
          { name: "project-key", min: 1, max: 1, value: { kind: "project-key" } },
          { name: "column-name", min: 1, max: 1, value: { kind: "column-name" } },
        ],
      },
    ],
    constraints: [],
  },
  column_delete: {
    options: { yes: { type: "boolean" } },
    forms: [
      {
        id: "default",
        positionals: [
          { name: "project-key", min: 1, max: 1, value: { kind: "project-key" } },
          { name: "column-name", min: 1, max: 1, value: { kind: "column-name" } },
        ],
      },
    ],
    constraints: [],
  },
  column_order: {
    options: {},
    forms: [
      {
        id: "absolute",
        positionals: [
          { name: "project-key", min: 1, max: 1, value: { kind: "project-key" } },
          { name: "column-name", min: 1, max: 1, value: { kind: "column-name" } },
          {
            name: "direction",
            min: 1,
            max: 1,
            value: { kind: "enum", choices: columnOrderSchema.options[0].shape.direction.options },
          },
        ],
      },
      {
        id: "relative",
        positionals: [
          { name: "project-key", min: 1, max: 1, value: { kind: "project-key" } },
          { name: "column-name", min: 1, max: 1, value: { kind: "column-name" } },
          {
            name: "direction",
            min: 1,
            max: 1,
            value: { kind: "enum", choices: columnOrderSchema.options[1].shape.direction.options },
          },
          { name: "target-column-name", min: 1, max: 1, value: { kind: "column-name" } },
        ],
      },
    ],
    constraints: [],
  },
} as const satisfies Record<string, CommandInput>;

export const projectRouter = {
  create: {
    summary: "Create a project with the default columns.",
    effects: { domain: "create", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: projectInputs.create,
    results: [jsonResult("Project")],
    run: async (args: Array<string>) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: projectInputs.create.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, projectInputs.create.options);
      validatePositionals(positionals, projectInputs.create.forms[0]);

      const projectKey = positionals[0]!;
      checkFieldsBeforeText(projectCreateSchema, { key: projectKey, name: values.name });
      const description = await resolveTextInput(
        values.description,
        values["description-file"],
        "--description",
      );

      try {
        const createdProject = project.create(
          { key: projectKey, name: values.name, description },
          currentActor(),
        );
        output(presentProject(createdProject), (entry) => formatProjectList([entry]));
      } catch (err) {
        throw err;
      }
    },
    help: `${generateCommandUsage("project create", projectInputs.create)}

Create a project with the default columns.
Project keys are stored in uppercase.

An omitted name defaults to the uppercase project key.
Names are trimmed and cannot be blank or contain line breaks or control characters.
Descriptions may contain multiple lines. If omitted, they are saved as null.
${textFileHelp("--description")}

${dashValueHelp("--description")}

Example: zinn project create MDR --name 'Macrodata Refinement'`,
  },
  list: {
    summary: "List projects with active and archived task counts.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: projectInputs.list,
    results: [jsonResult("ProjectList")],
    run: (args: Array<string>) => {
      const { positionals } = parseArgs({
        options: projectInputs.list.options,
        args,
        allowPositionals: true,
        strict: true,
      });
      validatePositionals(positionals, projectInputs.list.forms[0]);

      const projects: Array<PresentedProjectListEntry> = project
        .getAllWithTaskCounts()
        .map((entry) => ({ ...presentProject(entry), taskCounts: entry.taskCounts }));

      output(projects, (entries) => formatProjectList(entries, { showsTaskCounts: true }));
    },
    help: `${generateCommandUsage("project list", projectInputs.list)}

List projects with active and archived task counts.
Active tasks are unarchived tasks in any column, including Done.
With --json, each project includes taskCounts: { active, archived }, including zeros.

Example: zinn project list`,
  },
  view: {
    summary: "Show a project with its description and the number of tasks in each column.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: projectInputs.view,
    results: [jsonResult("ProjectView")],
    run: (args: Array<string>) => {
      const { positionals } = parseArgs({
        options: projectInputs.view.options,
        args,
        allowPositionals: true,
        strict: true,
      });
      validatePositionals(positionals, projectInputs.view.forms[0]);

      const projectKey = resolveProjectKey(positionals[0], { required: true })!;
      const projectMatch = project.getByKey(projectKey);

      if (projectMatch == null) {
        throw new CliError(
          `Project with key "${project.standardizeKey(projectKey)}" does not exist`,
          "not_found",
          { entity: "project", key: project.standardizeKey(projectKey), source: "explicit" },
        );
      }

      const taskCounts = column.getTaskCountsByProjectKey(projectMatch.key);
      const presentedProject: PresentedProjectView = {
        ...presentProject(projectMatch),
        columns: presentColumnTaskCounts(taskCounts),
        archivedTaskCount: taskCounts.archivedTaskCount,
      };

      output(presentedProject, (viewedProject) => {
        // The full description follows as its own section, so the row leaves out the preview.
        const sections = [formatProjectList([viewedProject], { showsDescriptionPreview: false })];

        if (viewedProject.description != null) {
          sections.push(formatSection("Description", viewedProject.description));
        }

        if (viewedProject.columns.length > 0) {
          const columnTaskCounts = formatColumnList(viewedProject.columns, {
            showsTaskCounts: true,
            archivedTaskCount: viewedProject.archivedTaskCount,
          });
          sections.push(formatSection("Columns", columnTaskCounts));
        }

        return sections.join("\n\n");
      });
    },
    help: `${generateCommandUsage("project view", projectInputs.view)}

Show a project with its description and the number of tasks in each column.
${requiredProjectDescription}
The description prints in full, keeping its line breaks. Archived tasks are counted as one total.

Example: zinn project view MDR`,
  },
  edit: {
    summary: "Change the supplied project fields. At least one edit flag is required.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: projectInputs.edit,
    results: [jsonResult("ProjectChange")],
    run: async (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: projectInputs.edit.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, projectInputs.edit.options);
      validatePositionals(positionals, projectInputs.edit.forms[0]);

      const projectChoice = chooseProjectKey(positionals[0], { required: true })!;
      checkFieldsBeforeText(projectEditSchema, {
        projectKey: projectChoice.key,
        name: values.name,
      });
      const description = await resolveTextEdit(values, "--description");

      // Without a text source nothing was read, so this usage error still comes before any input
      if (violatesConstraint(projectEditConstraint, getOptionInputs(values))) {
        quit("Provide an edit flag: --name, --description or --description-file", undefined, {
          field: [],
        });
      }
      checkDefaultProject(projectChoice);

      const editedProject = project.edit(
        { projectKey: projectChoice.key, name: values.name, description },
        currentActor(),
      );
      outputChanges(
        [editedProject],
        (change) => presentProject(change.project),
        formatProjectList,
        (entry) => `Project ${entry.key} was unchanged`,
      );
    },
    help: `${generateCommandUsage("project edit", projectInputs.edit)}

Change the supplied project fields. At least one edit flag is required.
With --json, changed is false when all supplied values already match.
${requiredProjectDescription}
Use --description '' to clear the description.
${textFileHelp("--description")}

${textEditHelp("--description")}

${dashValueHelp("--description")}

Examples:
  zinn project edit MDR --name 'Macrodata Refinement'
  zinn project edit MDR --description database --replacing board --all`,
  },
  delete: {
    summary: "Permanently delete a project and all of its columns and tasks after confirmation.",
    effects: { domain: "delete", storage: "normal-open" },
    confirmation: {
      kind: "project-delete",
      description: `${confirmationDescription} When the project key is omitted, deleting the configured default project always requires a terminal prompt; --yes is ignored.`,
    },
    input: projectInputs.delete,
    results: [jsonResult("Project")],
    run: async (args: Array<string>) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: projectInputs.delete.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens, projectInputs.delete.options);
      validatePositionals(positionals, projectInputs.delete.forms[0]);

      const typedProjectKey = positionals[0];
      const projectKey = resolveProjectKey(typedProjectKey, { required: true })!;

      try {
        const projectMatch = project.getByKey(projectKey);

        if (projectMatch == null) {
          throw new CliError(`Project with key "${projectKey}" does not exist`, "not_found", {
            entity: "project",
            key: projectKey,
            source: "explicit",
          });
        }

        // Like `gh repo delete`: --yes never skips the prompt for a project the command did not name
        const isYesIgnored = values.yes === true && typedProjectKey === undefined;
        if (isYesIgnored && !canPrompt()) {
          quit(
            `Cannot delete the default project ${projectMatch.key} without a terminal. Type its key to use --yes: zinn project delete ${projectMatch.key} --yes`,
            undefined,
            { argument: "project-key", reason: "confirmation_required" },
          );
        }

        if (isYesIgnored) {
          diagnostic("Warning: --yes is ignored because no project key was typed");
        }

        const canDelete = await confirmAction(
          `Are you sure you want to delete ${projectMatch.key} and all of its columns and tasks?`,
          values.yes === true && typedProjectKey !== undefined,
          typedProjectKey === undefined
            ? "Project deletion with --json needs a typed <project-key> and --yes"
            : undefined,
        );

        if (canDelete) {
          const deletedProject = project.delete(projectKey, currentActor());
          output(presentProject(deletedProject), (p) => `Deleted ${formatProjectList([p])}`);
        } else {
          output(
            presentProject(projectMatch),
            (p) => `Deletion cancelled for ${formatProjectList([p])}`,
          );
        }
      } catch (err) {
        throw err;
      }
    },
    help: `${generateCommandUsage("project delete", projectInputs.delete)}

Permanently delete a project and all of its columns and tasks after confirmation.
${requiredProjectDescription}
When the project key is omitted, confirmation is always required: --yes is ignored, and without a terminal the command refuses.
Use a typed project key and --yes to skip the prompt, including with --json.

Example: zinn project delete MDR`,
  },
  column: {
    create: {
      summary: "Add a column at the end of a project's board.",
      effects: { domain: "create", storage: "normal-open" },
      confirmation: { kind: "none" },
      input: projectInputs.column_create,
      results: [jsonResult("Column")],
      run: (args: Array<string>) => {
        const { positionals } = parseArgs({
          options: projectInputs.column_create.options,
          args,
          allowPositionals: true,
          strict: true,
        });
        validatePositionals(positionals, projectInputs.column_create.forms[0]);

        const projectKey = positionals[0]!;
        const columnName = positionals[1]!;

        try {
          const createdColumn = column.create({ projectKey, name: columnName }, currentActor());
          output(presentColumn(createdColumn), (entry) =>
            formatColumnList([entry], { showsProject: true }),
          );
        } catch (err) {
          throw err;
        }
      },
      help: `${generateCommandUsage("project column create", projectInputs.column_create)}

Add a column at the end of a project's board.
Names are trimmed, cannot be blank or contain line breaks or control characters, and must be unique within the project regardless of casing.

Example: zinn project column create MDR Boardlog`,
    },
    list: {
      summary: "List a project's columns in board order with their unarchived task counts.",
      effects: { domain: "read", storage: "normal-open" },
      confirmation: { kind: "none" },
      input: projectInputs.column_list,
      results: [jsonResult("ColumnList")],
      run: (args: Array<string>) => {
        const { positionals } = parseArgs({
          options: projectInputs.column_list.options,
          args,
          allowPositionals: true,
          strict: true,
        });
        validatePositionals(positionals, projectInputs.column_list.forms[0]);

        const projectKey = resolveProjectKey(positionals[0], { required: true })!;
        const columns = presentColumnTaskCounts(column.getTaskCountsByProjectKey(projectKey));
        output(columns, (presentedColumns) =>
          formatColumnList(presentedColumns, {
            showsTaskCounts: true,
          }),
        );
      },
      help: `${generateCommandUsage("project column list", projectInputs.column_list)}

List a project's columns in board order with their unarchived task counts.
${requiredProjectDescription}

Example: zinn project column list MDR`,
    },
    edit: {
      summary: "Rename a column.",
      effects: { domain: "update", storage: "normal-open" },
      confirmation: { kind: "none" },
      input: projectInputs.column_edit,
      results: [jsonResult("ColumnChange")],
      run: (args: Array<string>) => {
        const { values, positionals, tokens } = parseArgs({
          args,
          options: projectInputs.column_edit.options,
          allowPositionals: true,
          strict: true,
          tokens: true,
        });

        validateUniqueOptions(tokens, projectInputs.column_edit.options);
        validatePositionals(positionals, projectInputs.column_edit.forms[0]);

        const name = requireStringOption(
          projectInputs.column_edit.options.name,
          values.name,
          "name",
          "Provide an edit flag: --name",
        );

        const editedColumn = column.edit(
          {
            projectKey: positionals[0]!,
            columnName: positionals[1]!,
            name,
          },
          currentActor(),
        );
        outputChanges(
          [editedColumn],
          (change) => presentColumn(change.column),
          (entries) => formatColumnList(entries, { showsProject: true }),
          (entry) => `Column "${entry.name}" was unchanged`,
        );
      },
      help: `${generateCommandUsage("project column edit", projectInputs.column_edit)}

Rename a column.
The --name flag is required.
With --json, changed is false when the name already matches.

Columns are matched by name, and matching is case-insensitive.
Names are trimmed, and must remain unique within the same project.
Changing only the casing of a column's own name is allowed.

${dashValueHelp("--name")}

Example: zinn project column edit MDR 'In Progress' --name Refining`,
    },
    order: {
      summary: "Change a column's position on the project's board.",
      effects: { domain: "update", storage: "normal-open" },
      confirmation: { kind: "none" },
      input: projectInputs.column_order,
      results: [jsonResult("ColumnChange")],
      run: (args: Array<string>) => {
        const { positionals } = parseArgs({
          options: projectInputs.column_order.options,
          args,
          allowPositionals: true,
          strict: true,
        });
        const form = validateOrderForms(positionals, projectInputs.column_order.forms);
        const projectKey = positionals[0]!;
        const columnName = positionals[1]!;
        let orderedColumn: ReturnType<typeof column.order>;
        if (form.id === "relative") {
          orderedColumn = column.order(
            {
              projectKey,
              columnName,
              direction: form.direction,
              targetColumnName: positionals[form.directionIndex + 1]!,
            },
            currentActor(),
          );
        } else {
          orderedColumn = column.order(
            { projectKey, columnName, direction: form.direction },
            currentActor(),
          );
        }

        outputChanges(
          [orderedColumn],
          (change) => presentColumn(change.column),
          (entries) => formatColumnList(entries, { showsProject: true }),
          (entry) => `Column "${entry.name}" was already in that position`,
        );
      },
      help: `${generateCommandUsage("project column order", projectInputs.column_order)}

Change a column's position on the project's board.
Use first or last for either end, previous or next for one position,
  or before or after to place it relative to another column.

Columns are matched by name, and matching is case-insensitive.
Ordering to the current position, or before or after itself, leaves the column unchanged.
With --json, changed is false when the column was already in that position.

Example: zinn project column order MDR Review before 'In Progress'`,
    },
    delete: {
      summary: "Delete an empty project column after confirmation.",
      effects: { domain: "delete", storage: "normal-open" },
      confirmation: { kind: "prompt", description: confirmationDescription },
      input: projectInputs.column_delete,
      results: [jsonResult("Column")],
      run: async (args) => {
        const { values, positionals, tokens } = parseArgs({
          args,
          options: projectInputs.column_delete.options,
          allowPositionals: true,
          strict: true,
          tokens: true,
        });
        validateUniqueOptions(tokens, projectInputs.column_delete.options);
        validatePositionals(positionals, projectInputs.column_delete.forms[0]);

        const props = columnDeleteSchema.parse({
          projectKey: positionals[0],
          columnName: positionals[1],
        });
        const columnMatch = column.getByName(props.projectKey, props.columnName);
        const presentedColumn = presentColumn(columnMatch);
        const canDelete = await confirmAction(
          `Are you sure you want to delete column "${columnMatch.name}" from ${presentedColumn.project}?`,
          values.yes === true,
        );

        if (!canDelete) {
          output(
            presentedColumn,
            (entry) =>
              `Deletion cancelled for ${formatColumnList([entry], { showsProject: true })}`,
          );
          return;
        }

        const deletedColumn = column.delete(props, currentActor());
        output(
          presentColumn(deletedColumn),
          (entry) => `Deleted ${formatColumnList([entry], { showsProject: true })}`,
        );
      },
      help: `${generateCommandUsage("project column delete", projectInputs.column_delete)}

Delete an empty project column after confirmation.
Columns are matched by name, and matching is case-insensitive.
A column must hold no active or archived tasks. Use task move or task delete to clear it.
New tasks enter the project's first column unless --column selects another.
A project may have no columns. Add one with project column create before creating tasks.

Use --yes to skip the confirmation prompt, including with --json.

Example: zinn project column delete MDR Review`,
    },
  },
} satisfies RouteDef;
