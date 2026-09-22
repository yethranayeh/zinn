import type { RouteDef } from "../types";

import { parseArgs } from "node:util";

import { column, project } from "@zinn-dev/core";
import {
  confirmAction,
  output,
  quit,
  validatePositionalCount,
  validateUniqueOptions,
} from "../lib";

type PresentedProject = { key: string; name: string };

function presentProject(projectMatch: PresentedProject): PresentedProject {
  return { key: projectMatch.key, name: projectMatch.name };
}

function formatProject(presented: PresentedProject) {
  return `${presented.key} | ${presented.name}`;
}

export const projectRouter = {
  edit: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { name: { type: "string" } },
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

      if (values.name === undefined) {
        quit("Provide an edit flag: --name");
      }

      const editedProject = project.edit({ projectKey, name: values.name });
      output(presentProject(editedProject), formatProject);
    },
    help: `Usage: zinn project edit <project-key> --name <text>

Change the project name.
The --name flag is required.

Unchanged names leave the modification timestamp unchanged.

Example: zinn project edit MDR --name "Macrodata Refinement"`,
  },

  create: {
    run: (args: Array<string>) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { name: { type: "string" } },
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
        const createdProject = project.create({ key: projectKey, name: values.name });
        output(presentProject(createdProject), formatProject);
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: `Usage: zinn project create <project-key> [--name <text>]

Create a project with the default columns.
Project keys are stored in uppercase.

An omitted name defaults to the uppercase project key.
Names cannot be blank.

Example: zinn project create MDR --name "Macrodata Refinement"`,
  },
  list: {
    run: () => {
      const projects = project.getAll();

      output(projects.map(presentProject), (presentedProjects) => {
        const longestKeyLength = presentedProjects.reduce(
          (prev, current) => Math.max(prev, current.key.length),
          0,
        );

        return presentedProjects
          .map((p) => `${p.key.padEnd(longestKeyLength)} | ${p.name}`)
          .join("\n");
      });
    },
    help: `Usage: zinn project list

List projects and their keys.

Example: zinn project list`,
  },
  delete: {
    run: (args: Array<string>) => {
      const projectKey = args[0];

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
        );

        if (canDelete) {
          const deletedProject = project.delete(projectKey);
          output(presentProject(deletedProject), (p) => `Deleted ${formatProject(p)}`);
        } else {
          output(presentProject(projectMatch), (p) => `Deletion cancelled for ${formatProject(p)}`);
        }
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: `Usage: zinn project delete <project-key>

Permanently delete a project and all of its columns and tasks after confirmation.

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
          const createdColumn = column.create({ projectKey, name: columnName });
          const columnProject = project.getById(createdColumn.project_id)!;
          const presentedColumn = { project: columnProject.key, name: createdColumn.name };

          output(presentedColumn, (c) => `${c.project} | ${c.name}`);
        } catch (err: any) {
          quit(err?.message ?? "Something went wrong");
        }
      },
      help: `Usage: zinn project column create <project-key> <column-name>

Add a column at the end of a project's board.

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
  },
} satisfies RouteDef;
