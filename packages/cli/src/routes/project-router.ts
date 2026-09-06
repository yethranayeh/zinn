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
        project.create({ key: projectKey, name: projectName });
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: ``,
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
    help: "",
  },
  delete: {
    run: (args: Array<string>) => {
      const projectKey = args[0];

      if (projectKey == null) {
        quit("You need to specificy which project to delete");
      }

      try {
        // TODO: add y/n confirmation
        project.delete(projectKey);
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: ``,
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
          column.create({ projectKey, name: columnName });
        } catch (err: any) {
          quit(err?.message ?? "Something went wrong");
        }
      },
      help: ``,
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
      help: ``,
    },
  },
} satisfies RouteDef;
