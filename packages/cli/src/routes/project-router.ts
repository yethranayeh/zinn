import type { RouteDef } from "../types";
import type { PresentedTask } from "../presentation/task-presentation";

import { parseArgs } from "node:util";

import { column, project, task } from "@zinn-dev/core";
import {
  confirmAction,
  output,
  quit,
  validatePositionalCount,
  validateUniqueOptions,
} from "../lib";
import { formatTaskList, presentTask } from "../presentation/task-presentation";
import { formatDescriptionPreview } from "../presentation/description-presentation";
import { formatCellSeparator, formatRows } from "../presentation/row-layout";
import { currentActor } from "../actor";

type PresentedProject = { key: string; name: string; description: string | null };
type PresentedProjectView = PresentedProject & { tasks: Array<PresentedTask> };

function presentProject(projectMatch: PresentedProject): PresentedProject {
  return { key: projectMatch.key, name: projectMatch.name, description: projectMatch.description };
}

function formatProject(presented: PresentedProject) {
  return formatProjectList([presented]);
}

function formatProjectList(presentedProjects: Array<PresentedProject>) {
  return formatRows(
    presentedProjects.map((presented) => {
      const descriptionPreview = formatDescriptionPreview(presented.description);
      const description =
        descriptionPreview.length > 0 ? `${formatCellSeparator()}${descriptionPreview}` : "";

      return [{ text: presented.key }, { text: `${presented.name}${description}` }];
    }),
  );
}

type PresentedColumn = { project: string; name: string };

function presentColumn(columnMatch: { project_id: string; name: string }): PresentedColumn {
  const columnProject = project.getById(columnMatch.project_id)!;

  return { project: columnProject.key, name: columnMatch.name };
}

function formatColumn(presented: PresentedColumn) {
  return formatRows([[{ text: presented.project }, { text: presented.name }]]);
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

      const projectKey = positionals[0];

      if (projectKey == null) {
        quit("Project key must be specified");
      }

      validatePositionalCount(positionals, 1, "Only one project key can be specified");

      validateUniqueOptions(tokens);

      try {
        const createdProject = project.create(
          { key: projectKey, name: values.name, description: values.description },
          currentActor(),
        );
        output(presentProject(createdProject), formatProject);
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: `Usage: zinn project create <project-key> [--name <text>] [--description <text>]

Create a project with the default columns.
Project keys are stored in uppercase.

An omitted name defaults to the uppercase project key.
Names cannot be blank.
Descriptions may contain multiple lines. If omitted, they are saved as null.

Example: zinn project create MDR --name "Macrodata Refinement"`,
  },
  list: {
    run: () => {
      const projects = project.getAll();

      output(projects.map(presentProject), formatProjectList);
    },
    help: `Usage: zinn project list

List projects, their keys, and truncated description previews.

Example: zinn project list`,
  },
  view: {
    run: (args: Array<string>) => {
      const projectKey = args[0];

      if (projectKey == null) {
        quit("Project key must be specified");
      }

      validatePositionalCount(args, 1, "Only one project key can be specified");

      const projectMatch = project.getByKey(projectKey);

      if (projectMatch == null) {
        quit(`Project with key "${project.standardizeKey(projectKey)}" does not exist!`);
      }

      const presentedProject: PresentedProjectView = {
        ...presentProject(projectMatch),
        tasks: task.getAll({ projectKey, archive: "active" }).map(presentTask),
      };

      output(presentedProject, (viewedProject) => {
        const projectHeader = formatProject(viewedProject);
        const taskList = formatTaskList(viewedProject.tasks);

        return taskList.length === 0 ? projectHeader : `${projectHeader}\n\n${taskList}`;
      });
    },
    help: `Usage: zinn project view <project-key>

Show a project and its active tasks in board order.

Example: zinn project view MDR`,
  },
  edit: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { name: { type: "string" }, description: { type: "string" } },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      const projectKey = positionals[0];

      if (projectKey == null) {
        quit("Project key must be specified");
      }

      validatePositionalCount(positionals, 1, "Only one project key can be specified");

      validateUniqueOptions(tokens);

      if (values.name === undefined && values.description === undefined) {
        quit("Provide an edit flag: --name or --description");
      }

      const editedProject = project.edit(
        { projectKey, name: values.name, description: values.description },
        currentActor(),
      );
      output(presentProject(editedProject), formatProject);
    },
    help: `Usage: zinn project edit <project-key> [--name <text>] [--description <text>]

Change the supplied project fields. At least one edit flag is required.
Use --description "" to clear the description.

Example: zinn project edit MDR --name "Macrodata Refinement"`,
  },
  delete: {
    run: (args: Array<string>) => {
      const { values, positionals } = parseArgs({
        args,
        options: { yes: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      });
      const projectKey = positionals[0];

      if (projectKey == null) {
        quit("You need to specificy which project to delete");
      }

      try {
        const projectMatch = project.getByKey(projectKey);

        if (projectMatch == null) {
          throw new Error(`Project with key "${projectKey}" does not exist!`);
        }

        const canDelete = confirmAction(
          `Are you sure you want to delete ${projectMatch.key} and all of its columns and tasks?`,
          values.yes === true,
        );

        if (canDelete) {
          const deletedProject = project.delete(projectKey, currentActor());
          output(presentProject(deletedProject), (p) => `Deleted ${formatProject(p)}`);
        } else {
          output(presentProject(projectMatch), (p) => `Deletion cancelled for ${formatProject(p)}`);
        }
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: `Usage: zinn project delete <project-key> [--yes]

Permanently delete a project and all of its columns and tasks after confirmation.
Use --yes to skip the confirmation prompt, for example in scripts or with --json.

Example: zinn project delete MDR`,
  },
  column: {
    create: {
      run: (args: Array<string>) => {
        const projectKey = args[0];
        const columnName = args[1];

        if (projectKey == null || columnName == null) {
          quit("Both the project name and the column name must be defined");
        }

        try {
          const createdColumn = column.create({ projectKey, name: columnName }, currentActor());
          output(presentColumn(createdColumn), formatColumn);
        } catch (err: any) {
          quit(err?.message ?? "Something went wrong");
        }
      },
      help: `Usage: zinn project column create <project-key> <column-name>

Add a column at the end of a project's board.
Names are trimmed, cannot be blank or contain line breaks or control characters, and must be unique within the project regardless of casing.

Example: zinn project column create MDR "Boardlog"`,
    },
    list: {
      run: (args: Array<string>) => {
        const projectKey = args[0];
        if (projectKey == null) {
          quit("Project key needs to be specified to list columns");
        }

        // TODO: attach per-column task count
        // TODO: terminal formatting
        const columns = column.getAllByProjectKey(projectKey).map((c) => ({ name: c.name }));
        output(columns, (presentedColumns) => presentedColumns.map((c) => c.name).join("\n"));
      },
      help: `Usage: zinn project column list <project-key>

List a project's columns in board order.

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

        validatePositionalCount(
          positionals,
          2,
          "Both the project key and the column name must be specified",
        );
        validateUniqueOptions(tokens);

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
        const [projectKey, columnName, direction, targetColumnName, ...extraArgs] = args;

        if (projectKey == null || columnName == null) {
          quit("Both the project key and the column name must be specified");
        }

        if (direction == null) {
          quit("Order direction must be specified");
        }

        let orderedColumn: ReturnType<typeof column.order>;

        switch (direction) {
          case "before":
          case "after": {
            if (targetColumnName == null) {
              quit(`Target column must be specified for "${direction}"`);
            }

            if (extraArgs.length > 0) {
              quit("Only one target column can be specified");
            }

            orderedColumn = column.order(
              { projectKey, columnName, direction, targetColumnName },
              currentActor(),
            );
            break;
          }
          case "first":
          case "previous":
          case "next":
          case "last": {
            if (targetColumnName != null) {
              quit(`Order direction "${direction}" does not accept a target column`);
            }

            orderedColumn = column.order({ projectKey, columnName, direction }, currentActor());
            break;
          }
          default:
            quit(`Unknown order direction "${direction}"`);
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
