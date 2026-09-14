import type { RouteDef } from "../types";

import { parseArgs } from "node:util";

import { task, project, column } from "@zinn-dev/core";
import { quit } from "../lib";

function formatTask(
  taskMatch: ReturnType<typeof task.getByKey>,
  options: { showsStatus?: boolean } = {},
) {
  const taskProject = project.getById(taskMatch.project_id)!;
  const taskColumn = column.getById(taskMatch.column_id)!;
  const taskKey = `${taskProject.key}-${taskMatch.number}`;
  const status = options.showsStatus
    ? ` | ${taskMatch.archived_at == null ? "Active" : "Archived"}`
    : "";
  const description = taskMatch.description == null ? "" : ` | ${taskMatch.description}`;

  return `${taskKey}${status} | ${taskColumn.name} | ${taskMatch.title}${description}`;
}

export const taskRouter = {
  edit: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { title: { type: "string" }, description: { type: "string" } },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      const taskKey = positionals[0];

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      if (positionals.length > 1) {
        quit("Only one task key can be specified");
      }

      const parsedArgs = new Set<string>();
      for (const token of tokens) {
        if (token.kind !== "option") {
          continue;
        }

        if (parsedArgs.has(token.name)) {
          quit(`Option "--${token.name}" can only be specified once`);
        }

        parsedArgs.add(token.name);
      }

      if (values.title === undefined && values.description === undefined) {
        quit("Provide at least one edit flag: --title or --description");
      }

      const editedTask = task.edit({ taskKey, ...values });
      console.info(formatTask(editedTask));
    },
    help: `Usage: zinn task edit <task-key> [--title <text>] [--description <text>]

Change the supplied fields and preserve everything else.
Provide at least one edit flag. Use --description "" for an empty description.

Titles cannot be blank.
Archived tasks can be edited. Unchanged values leave the task unchanged.
Use --title="--example" for text beginning with a dash.

Example: zinn task edit MDR-1 --title "Meet the quarterly refinement quota"`,
  },
  create: {
    run: (args: Array<string>) => {
      const projectKey = args[0];
      if (projectKey == null) {
        quit("A task needs to belong to a project");
      }

      const taskTitle = args[1];
      if (taskTitle == null) {
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
        const createdTask = task.create({
          project_id: projectMatch.id,
          title: taskTitle,
          description: taskDesc ?? null,
        });
        console.info(formatTask(createdTask));
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: `Usage: zinn task create <project-key> <title> [description]

Create a task in the project's first column.

Example: zinn task create MDR "Refine the numbers" "Sort the numbers and meet the quarterly quota"`,
  },
  list: {
    run: (args) => {
      const showsArchived = args.includes("--archived");
      const showsAll = args.includes("--all");

      if (showsArchived && showsAll) {
        quit('Use either "--archived" or "--all", not both');
      }

      const positionalArgs = args.filter((arg) => !["--archived", "--all"].includes(arg));
      const projectKey = positionalArgs[0];

      if (positionalArgs.length > 1) {
        quit("Only one project key can be specified");
      }

      const archive = showsAll ? "all" : showsArchived ? "archived" : "active";

      const tasks = task.getAll({ projectKey, archive });

      if (tasks.length === 0) {
        return;
      }

      const presentableTasks = tasks.map((t) => {
        // TODO: A task's project and column is fetched in both `list` and `view`. Make a reusable fetcher?
        const taskProject = project.getById(t.project_id)!;
        const taskColumn = column.getById(t.column_id)!;
        const taskKey = `${taskProject.key}-${t.number}`;

        return {
          id: taskKey,
          status: t.archived_at == null ? "Active" : "Archived",
          title: t.title,
          description: t.description,
          column: taskColumn.name,
        };
      });

      const longestIdLength = presentableTasks.reduce(
        (prev, current) => Math.max(prev, current.id.length),
        0,
      );
      const longestStatusLength = presentableTasks.reduce(
        (prev, current) => Math.max(prev, current.status.length),
        0,
      );

      console.info(
        presentableTasks
          .map((t) => {
            // TODO: console output formatting for standardizied output
            const status = showsAll ? ` | ${t.status.padEnd(longestStatusLength)}` : "";
            const description = t.description == null ? "" : ` | ${t.description}`;
            return `${t.id.padEnd(longestIdLength)}${status} | ${t.column} | ${t.title}${description}`;
          })
          .join("\n"),
      );
    },
    help: `Usage: zinn task list [project-key] [--archived | --all]

List active tasks by default.
Use --archived to list archived tasks or --all to list both.

Example: zinn task list MDR --all`,
  },
  view: {
    run: (args) => {
      const taskKey = args[0];

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      const taskMatch = task.getByKey(taskKey);
      console.info(formatTask(taskMatch));
    },
    help: `Usage: zinn task view <task-key>

Show a task with its current column and description.

Example: zinn task view MDR-1`,
  },
  move: {
    run: (args) => {
      const [taskKey, targetColumn] = args;

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      if (targetColumn == null) {
        quit("Target column must be specified");
      }

      const movedTask = task.move({ taskKey, targetColumn });
      console.info(formatTask(movedTask));
    },
    help: `Usage: zinn task move <task-key> <target-column>

Move a task to another column in its project.
Moving a task to a different column lists it last in that column,
matching placement at the bottom of a visual kanban column.

Giving a task's current column as the target will not do anything.
Archived tasks must be unarchived before they can be moved.

Example: zinn task move MDR-1 "In Progress"`,
  },
  order: {
    run: (args) => {
      const [taskKey, direction, targetTaskKey, ...extraArgs] = args;

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      if (direction == null) {
        quit("Order direction must be specified");
      }

      switch (direction) {
        case "before":
        case "after": {
          if (targetTaskKey == null) {
            quit(`Target task must be specified for "${direction}"`);
          }

          if (extraArgs.length > 0) {
            quit("Only one target task can be specified");
          }

          const orderedTask = task.order({ taskKey, direction, targetTaskKey });
          console.info(formatTask(orderedTask));
          return;
        }
        case "top":
        case "up":
        case "down":
        case "bottom": {
          if (targetTaskKey != null) {
            quit(`Order direction "${direction}" does not accept a target task`);
          }

          const orderedTask = task.order({ taskKey, direction });
          console.info(formatTask(orderedTask));
          return;
        }
        default:
          quit(`Unknown order direction "${direction}"`);
      }
    },
    help: `Usage: zinn task order <task-key> <top | up | down | bottom>
       zinn task order <task-key> <before | after> <target-task-key>

Change a task's position within its current column.
Use top or bottom for either end, up or down for one position,
or before or after to place it relative to another task.

Example: zinn task order MDR-2 before MDR-1`,
  },
  delete: {
    run: (args: Array<string>) => {
      const taskKey = args[0];

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      try {
        const taskMatch = task.getByKey(taskKey);
        const canDelete = confirm(`Are you sure you want to delete ${taskKey}?`);

        if (canDelete) {
          const deletedTask = task.delete(taskKey);
          console.info(`Deleted ${formatTask(deletedTask)}`);
        } else {
          console.info(`Deletion cancelled for ${formatTask(taskMatch)}`);
        }
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: `Usage: zinn task delete <task-key>

Permanently delete a task after confirmation.

Example: zinn task delete MDR-1`,
  },
  archive: {
    run: (args: Array<string>) => {
      const taskKey = args[0];

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      const archivedTask = task.archive(taskKey);
      console.info(formatTask(archivedTask, { showsStatus: true }));
    },
    help: `Usage: zinn task archive <task-key>

Archive a task so it no longer appears in active task lists.

Example: zinn task archive MDR-1`,
  },
  unarchive: {
    run: (args: Array<string>) => {
      const taskKey = args[0];

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      const unarchivedTask = task.unarchive(taskKey);
      console.info(formatTask(unarchivedTask, { showsStatus: true }));
    },
    help: `Usage: zinn task unarchive <task-key>

Unarchive a task at the bottom of its previous column.

Example: zinn task unarchive MDR-1`,
  },
} satisfies RouteDef;
