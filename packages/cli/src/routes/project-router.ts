import { project } from "@zinn-dev/core";
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
};
