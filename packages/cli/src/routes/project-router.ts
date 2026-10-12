import type { RouteDef } from "../types.js";
import type {
  PresentedColumn,
  PresentedColumnTaskCount,
} from "../presentation/column-presentation.js";

import { parseArgs } from "node:util";

import { column, project } from "@zinn-dev/core";
import {
  canPrompt,
  confirmAction,
  failureMessage,
  output,
  quit,
  UsageError,
  validatePositionals,
  validateUniqueOptions,
} from "../lib.js";
import { resolveTextEdit, textEditHelp, textEditOptions, textEditUsage } from "../text-edit.js";
import { formatColumnList } from "../presentation/column-presentation.js";
import { formatDescriptionPreview } from "../presentation/description-presentation.js";
import { formatCellSeparator, formatRows } from "../presentation/row-layout.js";
import { formatSection } from "../presentation/section.js";
import { currentActor } from "../actor.js";
import { resolveProjectKey } from "../project.js";

type PresentedProject = { key: string; name: string; description: string | null };
type PresentedProjectView = PresentedProject & {
  columns: Array<PresentedColumnTaskCount>;
  archivedTaskCount: number;
};
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

export const projectRouter = {
  create: {
    run: (args: Array<string>) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { name: { type: "string" }, description: { type: "string" } },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens);
      validatePositionals(positionals, ["<project-key>"]);

      const projectKey = positionals[0]!;

      try {
        const createdProject = project.create(
          { key: projectKey, name: values.name, description: values.description },
          currentActor(),
        );
        output(presentProject(createdProject), formatProject);
      } catch (err: any) {
        quit(failureMessage(err, "Something went wrong"));
      }
    },
    help: `Usage: zinn project create <project-key> [--name <text>] [--description <text>]

Create a project with the default columns.
Project keys are stored in uppercase.

An omitted name defaults to the uppercase project key.
Names are trimmed and cannot be blank or contain line breaks or control characters.
Descriptions may contain multiple lines. If omitted, they are saved as null.

Example: zinn project create MDR --name "Macrodata Refinement"`,
  },
  list: {
    run: (args: Array<string>) => {
      const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
      validatePositionals(positionals, []);

      const projects = project.getAll();

      output(projects.map(presentProject), formatProjectList);
    },
    help: `Usage: zinn project list

List projects, their keys, and truncated description previews.

Example: zinn project list`,
  },
  view: {
    run: (args: Array<string>) => {
      const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
      validatePositionals(positionals, ["[<project-key>]"]);

      const projectKey = resolveProjectKey(positionals[0], { required: true })!;
      const projectMatch = project.getByKey(projectKey);

      if (projectMatch == null) {
        quit(`Project with key "${project.standardizeKey(projectKey)}" does not exist!`);
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
    help: `Usage: zinn project view [<project-key>]

Show a project with its description and the number of tasks in each column.
An omitted project key uses defaultProject from settings, if present.
If no default project is set, the key is required.
The description prints in full, keeping its line breaks. Archived tasks are counted as one total.

Example: zinn project view MDR`,
  },
  edit: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { name: { type: "string" }, description: { type: "string" }, ...textEditOptions },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens);
      validatePositionals(positionals, ["[<project-key>]"]);

      const projectKey = resolveProjectKey(positionals[0], { required: true })!;
      const description = resolveTextEdit(values.description, values, "--description");

      if (values.name === undefined && description === undefined) {
        quit("Provide an edit flag: --name or --description");
      }

      const editedProject = project.edit(
        { projectKey, name: values.name, description },
        currentActor(),
      );
      output(presentProject(editedProject), formatProject);
    },
    help: `Usage: zinn project edit [<project-key>] [--name <text>] [--description <text> ${textEditUsage}]

Change the supplied project fields. At least one edit flag is required.
An omitted project key uses defaultProject from settings, if present.
If no default project is set, the key is required.
Use --description "" to clear the description.

${textEditHelp("--description")}

Examples:
  zinn project edit MDR --name "Macrodata Refinement"
  zinn project edit MDR --description "database" --replacing "board" --all`,
  },
  delete: {
    run: async (args: Array<string>) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { yes: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens);
      validatePositionals(positionals, ["[<project-key>]"]);

      const typedProjectKey = positionals[0];
      const projectKey = resolveProjectKey(typedProjectKey, { required: true })!;

      try {
        const projectMatch = project.getByKey(projectKey);

        if (projectMatch == null) {
          throw new Error(`Project with key "${projectKey}" does not exist!`);
        }

        // Like `gh repo delete`: --yes never skips the prompt for a project the command did not name
        const isYesIgnored = values.yes === true && typedProjectKey === undefined;
        if (isYesIgnored && !canPrompt()) {
          quit(
            `Cannot delete the default project ${projectMatch.key} without a terminal. Type its key to use --yes: zinn project delete ${projectMatch.key} --yes`,
          );
        }

        if (isYesIgnored) {
          console.error("Warning: --yes is ignored because no project key was typed");
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
      } catch (err: any) {
        quit(failureMessage(err, "Something went wrong"));
      }
    },
    help: `Usage: zinn project delete [<project-key>] [--yes]

Permanently delete a project and all of its columns and tasks after confirmation.
An omitted project key uses defaultProject from settings, if present.
If no default project is set, the key is required.
With the default, confirmation is always required: --yes is ignored, and without a terminal the command refuses.
Use a typed project key and --yes to skip the prompt, including with --json.

Example: zinn project delete MDR`,
  },
  column: {
    create: {
      run: (args: Array<string>) => {
        const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
        validatePositionals(positionals, ["<project-key>", "<column-name>"]);

        const projectKey = positionals[0]!;
        const columnName = positionals[1]!;

        try {
          const createdColumn = column.create({ projectKey, name: columnName }, currentActor());
          output(presentColumn(createdColumn), formatColumn);
        } catch (err: any) {
          quit(failureMessage(err, "Something went wrong"));
        }
      },
      help: `Usage: zinn project column create <project-key> <column-name>

Add a column at the end of a project's board.
Names are trimmed, cannot be blank or contain line breaks or control characters, and must be unique within the project regardless of casing.

Example: zinn project column create MDR "Boardlog"`,
    },
    list: {
      run: (args: Array<string>) => {
        const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
        validatePositionals(positionals, ["[<project-key>]"]);

        const projectKey = resolveProjectKey(positionals[0], { required: true })!;
        const taskCounts = column.getTaskCountsByProjectKey(projectKey);
        const columns = taskCounts.columns.map((columnCount) => ({
          name: columnCount.column.name,
          taskCount: columnCount.taskCount,
        }));
        output(columns, (presentedColumns) =>
          formatColumnList(presentedColumns, {
            showsTaskCounts: true,
          }),
        );
      },
      help: `Usage: zinn project column list [<project-key>]

List a project's columns in board order with their unarchived task counts.
An omitted project key uses defaultProject from settings, if present.
If no default project is set, the key is required.

Example: zinn project column list MDR`,
    },
    edit: {
      run: (args: Array<string>) => {
        const { values, positionals, tokens } = parseArgs({
          args,
          options: { name: { type: "string" } },
          allowPositionals: true,
          strict: true,
          tokens: true,
        });

        validateUniqueOptions(tokens);
        validatePositionals(positionals, ["<project-key>", "<column-name>"]);

        if (values.name === undefined) {
          quit("Provide an edit flag: --name");
        }

        const editedColumn = column.edit(
          {
            projectKey: positionals[0]!,
            columnName: positionals[1]!,
            name: values.name,
          },
          currentActor(),
        );
        output(presentColumn(editedColumn), formatColumn);
      },
      help: `Usage: zinn project column edit <project-key> <column-name> --name <text>

Rename a column.
The --name flag is required.

Columns are matched by name, and matching is case-insensitive.
Names are trimmed, and must remain unique within the same project.
Changing only the casing of a column's own name is allowed.

Example: zinn project column edit MDR "In Progress" --name "Refining"`,
    },
    order: {
      run: (args: Array<string>) => {
        const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
        /**
         * The words every direction needs. Only whether they are there is checked here,
         *  since the direction decides whether a target column follows.
         */
        const leadingWords = [
          "<project-key>",
          "<column-name>",
          "{first|previous|next|last|before|after}",
        ];
        validatePositionals(positionals.slice(0, leadingWords.length), leadingWords);

        const projectKey = positionals[0]!;
        const columnName = positionals[1]!;
        const direction = positionals[2]!;
        let orderedColumn: ReturnType<typeof column.order>;

        switch (direction) {
          case "before":
          case "after": {
            validatePositionals(positionals, [...leadingWords, "<target-column-name>"]);

            orderedColumn = column.order(
              { projectKey, columnName, direction, targetColumnName: positionals[3]! },
              currentActor(),
            );
            break;
          }
          case "first":
          case "previous":
          case "next":
          case "last": {
            validatePositionals(positionals, leadingWords);

            orderedColumn = column.order({ projectKey, columnName, direction }, currentActor());
            break;
          }
          default:
            throw new UsageError(`Unknown order direction "${direction}"`);
        }

        // TODO: maybe also print the new full column state?
        output(presentColumn(orderedColumn), formatColumn);
      },
      help: `Usage: zinn project column order <project-key> <column-name> {first|previous|next|last}
       zinn project column order <project-key> <column-name> {before|after} <target-column-name>

Change a column's position on the project's board.
Use first or last for either end, previous or next for one position,
  or before or after to place it relative to another column.

Columns are matched by name, and matching is case-insensitive.

Example: zinn project column order MDR Review before "In Progress"`,
    },
  },
} satisfies RouteDef;
