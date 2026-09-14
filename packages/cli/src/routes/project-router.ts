import type { RouteDef } from "../types";

import { column, project } from "@zinn-dev/core";
import { quit } from "../lib";

export const projectRouter = {
  create: {
    run: (args: Array<string>) => {
      const projectName = args[0];
      // TODO: maybe auto generate project key from name instead of forcing explicit input (however, very open to collision)
      const projectKey = args[1];

      if (projectName == null || projectKey == null) {
        quit("Both the project name and the project key must be defined");
      }

      try {
        const createdProject = project.create({ key: projectKey, name: projectName });
        console.info(`${createdProject.key} | ${createdProject.name}`);
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: `Usage: zinn project create <name> <project-key>

Create a project with the default Backlog, TODO, In Progress, Review, and Done columns.
Project keys are stored in uppercase.

Example: zinn project create "Website refresh" SITE`,
  },
  list: {
    run: () => {
      const projects = project.getAll();
      if (projects.length === 0) {
        return;
      }

      const longestKeyLength = projects.reduce(
        (prev, current) => Math.max(prev, current.key.length),
        0,
      );

      console.info(projects.map((p) => `${p.key.padEnd(longestKeyLength)} | ${p.name}`).join("\n"));
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
        // TODO: add y/n confirmation
        const deletedProject = project.delete(projectKey);
        console.info(`Deleted ${deletedProject.key} | ${deletedProject.name}`);
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: `Usage: zinn project delete <project-key>

Permanently delete a project and all of its columns and tasks without confirmation.

Example: zinn project delete SITE`,
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

          console.info(`${columnProject.key} | ${createdColumn.name}`);
        } catch (err: any) {
          quit(err?.message ?? "Something went wrong");
        }
      },
      help: `Usage: zinn project column create <project-key> <column-name>

Add a column at the end of a project's board.

Example: zinn project column create SITE "Waiting for review"`,
    },
    list: {
      run: (args: Array<string>) => {
        const projectKey = args[0];
        if (projectKey == null) {
          quit("Project key needs to be specified to list columns");
        }

        // TODO: attach per-column task count
        // TODO: terminal formatting
        console.info(column.getAllByProjectKey(projectKey).map((c) => c.name));
      },
      help: `Usage: zinn project column list <project-key>

List a project's columns in board order.

Example: zinn project column list SITE`,
    },
  },
} satisfies RouteDef;
