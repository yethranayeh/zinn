import type { RouteDef } from "../types";

import { parseArgs } from "node:util";
import { task, project, positiveIntegerPattern, searchLimitMessage } from "@zinn-dev/core";

import {
  confirmAction,
  output,
  quit,
  validatePositionalCount,
  validateUniqueOptions,
} from "../lib";
import { formatRelations, presentRelations, relationRouter } from "./relation-router";
import { commentRouter, formatComments, presentComments } from "./comment-router";
import { currentActor } from "../actor";
import {
  formatTask,
  formatTaskList,
  formatTaskMove,
  formatTaskWithStatus,
  presentTask,
} from "../presentation/task-presentation";

const limitPattern = new RegExp(`^${positiveIntegerPattern}$`);

export const taskRouter = {
  create: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: {
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string" },
          label: { type: "string", multiple: true },
        },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      const projectKey = positionals[0];
      if (projectKey == null) {
        quit("A task needs to belong to a project");
      }
      validatePositionalCount(
        positionals,
        1,
        "Only one project key can be specified; use --title and --description",
      );
      if (values.title === undefined) {
        quit("A task needs at least a title: use --title");
      }
      validateUniqueOptions(tokens, ["label"]);
      const projectMatch = project.getByKey(projectKey);
      if (projectMatch == null) {
        quit(`Project with key "${project.standardizeKey(projectKey)}" does not exist`);
      }
      const createdTask = task.create(
        {
          project_id: projectMatch.id,
          title: values.title,
          description: values.description ?? null,
          priority: parsePriority(values.priority),
          labelNames: values.label,
        },
        currentActor(),
      );
      output(presentTask(createdTask), formatTask);
    },
    help: `Usage: zinn task create <project-key> --title <text> [--description <text>] [--priority {low|medium|high|urgent|none}] [--label <name>]

Create a task in the project's first column.
Priority defaults to none (unassigned).
Repeat --label to attach multiple existing labels. Unknown labels are errors.
Titles cannot be blank. Use --title="--example" for text beginning with a dash.

Example: zinn task create MDR --title "Refine the numbers" --description "Meet the quarterly quota" --label urgent`,
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

      output(tasks.map(presentTask), (presentedTasks) =>
        formatTaskList(presentedTasks, { showsStatus: showsAll }),
      );
    },
    help: `Usage: zinn task list [<project-key>] [--archived|--all]

List active tasks by default.
Use --archived to list archived tasks or --all to list both.
Priority markers: - unassigned, L low, M medium, H high, U urgent.

Example: zinn task list MDR --all`,
  },
  search: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: {
          archived: { type: "boolean" },
          all: { type: "boolean" },
          limit: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      const [query, projectKey] = positionals;

      if (query == null) {
        quit("A search query must be specified");
      }

      if (positionals.length > 2) {
        quit("Only one query and one project key can be specified; quote multi-word queries");
      }

      validateUniqueOptions(tokens);

      if (values.archived && values.all) {
        quit('Use either "--archived" or "--all", not both');
      }

      const archive = values.all ? "all" : values.archived ? "archived" : "active";

      if (values.limit !== undefined && !limitPattern.test(values.limit)) {
        quit(searchLimitMessage);
      }

      const limit = values.limit === undefined ? undefined : Number(values.limit);
      const result = task.search({ query, projectKey, archive, limit });

      output(result.tasks.map(presentTask), (presentedTasks) =>
        formatTaskList(presentedTasks, { showsStatus: values.all }),
      );

      if (result.hiddenArchivedCount > 0) {
        const count = result.hiddenArchivedCount;
        const noun = count === 1 ? "match" : "matches";
        console.error(`${count} archived ${noun} hidden, use --all to include them`);
      }
    },
    help: `Usage: zinn task search <query> [<project-key>] [--archived|--all] [--limit <n>]

Search task titles, descriptions, and comments. A comment match lists the task it belongs to.
Each word matches the start of a word, ignoring case and accents: e.g. "auth" finds "Authentication".
Every word must match. Quote a query with several words.

A query that is exactly a task key, such as MDR-1, lists that task first.
Other results are ordered by relevance, with title matches weighted highest.
Equally relevant tasks are ordered by project key, then task number.

By default, only active tasks are searched. Use --archived to search archived tasks or --all to search both.
When archived matches are hidden, a note is printed to say how many.
Use --limit to show at most <n> results.
A search result's output matches that of 'task list'.

Use -- before a query that begins with a dash.

Example: zinn task search "refinement quota" MDR --limit 5`,
  },
  view: {
    run: (args) => {
      const taskKey = args[0];

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      const taskMatch = task.getByKey(taskKey);
      const viewedTask = {
        ...presentTask(taskMatch),
        relations: presentRelations(taskMatch),
        comments: presentComments(taskMatch.key),
      };

      output(viewedTask, (t) => {
        const relations = formatRelations(t.relations);
        const comments = formatComments(t.comments);
        const formattedTask = formatTask(t);
        const sections = [formattedTask];

        if (relations.length > 0) {
          sections.push(`Relations:\n${relations}`);
        }

        if (comments.length > 0) {
          sections.push(`Comments:\n${comments}`);
        }

        return sections.join("\n\n");
      });
    },
    help: `Usage: zinn task view <task-key>

Show a task with its current column, description, priority, labels, relations, and comments.

Example: zinn task view MDR-1`,
  },
  edit: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: {
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string" },
          "add-label": { type: "string", multiple: true },
          "remove-label": { type: "string", multiple: true },
        },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      const taskKey = positionals[0];

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      validatePositionalCount(positionals, 1, "Only one task key can be specified");

      validateUniqueOptions(tokens, ["add-label", "remove-label"]);

      const hasEditFlags =
        values.title !== undefined ||
        values.description !== undefined ||
        values.priority !== undefined ||
        values["add-label"] !== undefined ||
        values["remove-label"] !== undefined;

      if (!hasEditFlags) {
        quit(
          "Provide at least one edit flag: --title, --description, --priority, --add-label, or --remove-label",
        );
      }

      const editedTask = task.edit(
        {
          taskKey,
          title: values.title,
          description: values.description,
          priority: parsePriority(values.priority),
          addLabelNames: values["add-label"],
          removeLabelNames: values["remove-label"],
        },
        currentActor(),
      );

      output(presentTask(editedTask), formatTask);
    },
    help: `Usage: zinn task edit <task-key> [--title <text>] [--description <text>] [--priority {low|medium|high|urgent|none}] [--add-label <name>] [--remove-label <name>]

Change the supplied fields and preserve everything else.
Use --priority none to clear priority.
Provide at least one edit flag. Use --description "" for an empty description.

Repeat --add-label or --remove-label for multiple existing labels.
Adding an attached label or removing an unattached label does not do anything.
Archived tasks can be edited. Unchanged values leave the task unchanged.

The same label cannot be both added and removed.
Titles cannot be blank.

Use --title="--example" for text beginning with a dash.

Example: zinn task edit MDR-1 --title "Meet the quarterly refinement quota"`,
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

      const movedTask = task.move({ taskKey, targetColumn }, currentActor());
      output(presentTask(movedTask), formatTaskMove);
    },
    help: `Usage: zinn task move <task-key> <target-column>

Move a task to another column in its project.
Moving a task to a different column lists it last in that column,
matching placement at the bottom of a visual kanban column.

Prints the task's key and new column.

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

          const orderedTask = task.order({ taskKey, direction, targetTaskKey }, currentActor());
          output(presentTask(orderedTask), formatTask);
          return;
        }
        case "top":
        case "up":
        case "down":
        case "bottom": {
          if (targetTaskKey != null) {
            quit(`Order direction "${direction}" does not accept a target task`);
          }

          const orderedTask = task.order({ taskKey, direction }, currentActor());
          output(presentTask(orderedTask), formatTask);
          return;
        }
        default:
          quit(`Unknown order direction "${direction}"`);
      }
    },
    help: `Usage: zinn task order <task-key> {top|up|down|bottom}
       zinn task order <task-key> {before|after} <target-task-key>

Change a task's position within its current column.
Use top or bottom for either end, up or down for one position,
or before or after to place it relative to another task.

Example: zinn task order MDR-2 before MDR-1`,
  },
  archive: {
    run: (args: Array<string>) => {
      const taskKey = args[0];

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      const archivedTask = task.archive(taskKey, currentActor());
      output(presentTask(archivedTask), formatTaskWithStatus);
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

      const unarchivedTask = task.unarchive(taskKey, currentActor());
      output(presentTask(unarchivedTask), formatTaskWithStatus);
    },
    help: `Usage: zinn task unarchive <task-key>

Unarchive a task at the bottom of its previous column.

Example: zinn task unarchive MDR-1`,
  },
  delete: {
    run: (args: Array<string>) => {
      const { values, positionals } = parseArgs({
        args,
        options: { yes: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      });
      const taskKey = positionals[0];

      if (taskKey == null) {
        quit("Task key must be specified");
      }

      try {
        const taskMatch = task.getByKey(taskKey);
        const canDelete = confirmAction(
          `Are you sure you want to delete ${taskKey}?`,
          values.yes === true,
        );
        const presented = presentTask(taskMatch);

        if (canDelete) {
          task.delete(taskKey, currentActor());
          output(presented, (t) => `Deleted ${formatTask(t)}`);
        } else {
          output(presented, (t) => `Deletion cancelled for ${formatTask(t)}`);
        }
      } catch (err: any) {
        quit(err?.message ?? "Something went wrong");
      }
    },
    help: `Usage: zinn task delete <task-key> [--yes]

Permanently delete a task after confirmation.
Use --yes to skip the confirmation prompt, for example in scripts or with --json.

Example: zinn task delete MDR-1`,
  },
  relation: relationRouter,
  comment: commentRouter,
  label: {
    add: {
      run: (args) => {
        const props = parseTaskLabelArgs(args);
        output(presentTask(task.label.add(props, currentActor())), formatTask);
      },
      help: `Usage: zinn task label add <task-key> <label-name>...

Add existing labels to a task. Already attached labels are unchanged.`,
    },
    remove: {
      run: (args) => {
        const props = parseTaskLabelArgs(args);
        output(presentTask(task.label.remove(props, currentActor())), formatTask);
      },
      help: `Usage: zinn task label remove <task-key> <label-name>...

Remove existing labels from a task. Unattached labels are unchanged.
Label definitions are preserved.`,
    },
  },
} satisfies RouteDef;

function parseTaskLabelArgs(args: string[]) {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true });
  if (positionals.length < 2) {
    quit("Provide a task key and at least one label name");
  }
  return { taskKey: positionals[0]!, labelNames: positionals.slice(1) };
}

function parsePriority(value: string | undefined) {
  switch (value) {
    case undefined:
      return undefined;
    case "none":
      return null;
    case "low":
    case "medium":
    case "high":
    case "urgent":
      return value;
    default:
      quit("Priority must be low, medium, high, urgent, or none");
  }
}
