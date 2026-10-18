import type { RouteDef } from "../types.js";
import type { CommandInput, InputConstraint } from "../input.js";
import type {
  PresentedColumn,
  PresentedProject,
  PresentedProjectView,
  PresentedColumnTaskCount,
} from "../result-schemas.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import { column, project, columnOrderSchema } from "@zinn-dev/core";

import { CliError } from "../errors.js";
import { generateCommandUsage, getOptionInputs, noInput, violatesConstraint } from "../input.js";
import {
  confirmationDescription,
  canPrompt,
  confirmAction,
  dashValueHelp,
  diagnostic,
  output,
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
import { formatColumnList } from "../presentation/column-presentation.js";
import { formatDescriptionPreview } from "../presentation/description-presentation.js";
import { formatCellSeparator, formatRows } from "../presentation/row-layout.js";
import { formatSection } from "../presentation/section.js";
import { currentActor } from "../actor.js";
import { resolveProjectKey, requiredProjectDescription } from "../project.js";

type ProjectRowOptions = { showsDescriptionPreview?: boolean };

function presentProject(projectMatch: PresentedProject): PresentedProject {
  return { key: projectMatch.key, name: projectMatch.name, description: projectMatch.description };
}

function formatProject(presented: PresentedProject, options: ProjectRowOptions = {}) {
  return formatProjectList([presented], options);
}

function formatProjectList(
  presentedProjects: Array<PresentedProject>,
  { showsDescriptionPreview = true }: ProjectRowOptions = {},
) {
  return formatRows(
    presentedProjects.map((presented) => {
      const descriptionPreview = showsDescriptionPreview
        ? formatDescriptionPreview(presented.description)
        : "";
      const description =
        descriptionPreview.length > 0 ? `${formatCellSeparator()}${descriptionPreview}` : "";

      return [{ text: presented.key }, { text: `${presented.name}${description}` }];
    }),
  );
}

function presentColumn(columnMatch: { project_id: string; name: string }): PresentedColumn {
  const columnProject = project.getById(columnMatch.project_id)!;

  return { project: columnProject.key, name: columnMatch.name };
}

function formatColumn(presented: PresentedColumn) {
  return formatColumnList([presented], { showsProject: true });
}

const projectEditConstraint = {
  kind: "atLeastOne",
  members: ["option:name", "option:description"],
} as const satisfies InputConstraint;

const projectInputs = {
  create: {
    options: {
      name: { type: "string", value: { kind: "text", name: "text" } },
      description: { type: "string", value: { kind: "text", name: "text" } },
    },
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 1, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [],
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
      ...textEditOptions,
    },
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 0, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [...textEditConstraints("--description"), projectEditConstraint],
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
    run: (args: Array<string>) => {
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

      try {
        const createdProject = project.create(
          { key: projectKey, name: values.name, description: values.description },
          currentActor(),
        );
        output(presentProject(createdProject), formatProject);
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

${dashValueHelp("--description")}

Example: zinn project create MDR --name 'Macrodata Refinement'`,
  },
  list: {
    summary: "List projects, their keys, and truncated description previews.",
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

      const projects = project.getAll();

      output(projects.map(presentProject), formatProjectList);
    },
    help: `${generateCommandUsage("project list", projectInputs.list)}

List projects, their keys, and truncated description previews.

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
          `Project with key "${project.standardizeKey(projectKey)}" does not exist!`,
          "not_found",
          { entity: "project", key: project.standardizeKey(projectKey), source: "explicit" },
        );
      }

      const taskCounts = column.getTaskCountsByProjectKey(projectMatch.key);
      const presentedProject: PresentedProjectView = {
        ...presentProject(projectMatch),
        columns: taskCounts.columns.map((columnCount) => ({
          name: columnCount.column.name,
          taskCount: columnCount.taskCount,
        })),
        archivedTaskCount: taskCounts.archivedTaskCount,
      };

      output(presentedProject, (viewedProject) => {
        // The full description follows as its own section, so the row leaves out the preview.
        const sections = [formatProject(viewedProject, { showsDescriptionPreview: false })];

        if (viewedProject.description != null) {
          sections.push(formatSection("Description", viewedProject.description));
        }

        const columnTaskCounts = formatColumnList(viewedProject.columns, {
          showsTaskCounts: true,
          archivedTaskCount: viewedProject.archivedTaskCount,
        });
        sections.push(formatSection("Columns", columnTaskCounts));

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
    results: [jsonResult("Project")],
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: projectInputs.edit.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, projectInputs.edit.options);
      validatePositionals(positionals, projectInputs.edit.forms[0]);

      const projectKey = resolveProjectKey(positionals[0], { required: true })!;
      const description = resolveTextEdit(values.description, values, "--description");

      if (violatesConstraint(projectEditConstraint, getOptionInputs({ ...values, description }))) {
        quit("Provide an edit flag: --name or --description", undefined, { field: [] });
      }

      const editedProject = project.edit(
        { projectKey, name: values.name, description },
        currentActor(),
      );
      output(presentProject(editedProject), formatProject);
    },
    help: `${generateCommandUsage("project edit", projectInputs.edit)}

Change the supplied project fields. At least one edit flag is required.
${requiredProjectDescription}
Use --description '' to clear the description.

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
          throw new CliError(`Project with key "${projectKey}" does not exist!`, "not_found", {
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
          output(presentProject(deletedProject), (p) => `Deleted ${formatProject(p)}`);
        } else {
          output(presentProject(projectMatch), (p) => `Deletion cancelled for ${formatProject(p)}`);
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
          output(presentColumn(createdColumn), formatColumn);
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
        const taskCounts = column.getTaskCountsByProjectKey(projectKey);
        const columns: Array<PresentedColumnTaskCount> = taskCounts.columns.map((columnCount) => ({
          name: columnCount.column.name,
          taskCount: columnCount.taskCount,
        }));
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
      results: [jsonResult("Column")],
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
        output(presentColumn(editedColumn), formatColumn);
      },
      help: `${generateCommandUsage("project column edit", projectInputs.column_edit)}

Rename a column.
The --name flag is required.

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
      results: [jsonResult("Column")],
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
          const direction =
            positionals[2] as (typeof form)["positionals"][2]["value"]["choices"][number];
          orderedColumn = column.order(
            { projectKey, columnName, direction, targetColumnName: positionals[3]! },
            currentActor(),
          );
        } else {
          const direction =
            positionals[2] as (typeof form)["positionals"][2]["value"]["choices"][number];
          orderedColumn = column.order({ projectKey, columnName, direction }, currentActor());
        }

        // TODO: maybe also print the new full column state?
        output(presentColumn(orderedColumn), formatColumn);
      },
      help: `${generateCommandUsage("project column order", projectInputs.column_order)}

Change a column's position on the project's board.
Use first or last for either end, previous or next for one position,
  or before or after to place it relative to another column.

Columns are matched by name, and matching is case-insensitive.

Example: zinn project column order MDR Review before 'In Progress'`,
    },
  },
} satisfies RouteDef;
