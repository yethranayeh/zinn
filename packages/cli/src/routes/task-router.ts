import type { RouteDef } from "../types";

import { task, project } from "@zinn-dev/core";
import { quit } from "../lib";

export const taskRouter = {
  create: {
    run: (args: Array<string>) => {
      const projectKey = args[0];
      if (projectKey == null) {
        quit("A task needs to belong to a project");
      }

      const taskName = args[1];
      if (taskName == null) {
        quit("A task needs at least a title");
      }

      const taskDesc = args[2];

      // TODO: do empty strings bypass this check?

      try {
        const standardizedKey = project.standardizeKey(projectKey);
        // TODO: `getByKey` already standardizes the key, but to display it in standardized format, I also used it here. Should it run twice on the same thing?
        const projectMatch = project.getByKey(standardizedKey);
        if (projectMatch == null) {
          quit(`Project with key "${standardizedKey}" does not exist`);
        }

        // TODO: should it non-null (??) or non-falsy (||) check?
        task.create({
          project_id: projectMatch.id,
          name: taskName,
          description: taskDesc ?? null,
        });
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: ``,
  },
  list: {
    run: (args) => {
      const projectKey = args[0];

      // TODO: order by actual `t.order` per project
      const tasks = task.getAll({ projectKey });

      if (tasks.length === 0) {
        return;
      }

      const presentableTasks = tasks.map((t) => {
        const taskProject = project.getById(t.project_id)!;
        const taskVisualId = `${taskProject.key}-${t.number}`;

        return { id: taskVisualId, name: t.name, description: t.description };
      });

      const longestIdLength = presentableTasks.reduce(
        (prev, current) => Math.max(prev, current.id.length),
        0,
      );

      console.info(
        presentableTasks
          .map((t) => {
            return `${t.id.padEnd(longestIdLength)} | ${t.name} | ${t.description}`;
          })
          .join("\n"),
      );
    },
    help: "",
  },
} satisfies RouteDef;
