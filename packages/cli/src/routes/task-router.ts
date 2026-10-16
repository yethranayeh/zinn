import type { TaskChange, TaskRelationType } from "@zinn-dev/core";
import type { RouteDef } from "../types.js";
import type { PresentedTask } from "../presentation/task-presentation.js";

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import {
  task,
  project,
  positiveIntegerPattern,
  searchLimitMessage,
  parseTaskKey,
} from "@zinn-dev/core";

import {
  confirmAction,
  dashValueHelp,
  failureMessage,
  output,
  quit,
  UsageError,
  validatePositionals,
  validateUniqueOptions,
} from "../lib.js";
import { resolveTextEdit, textEditHelp, textEditOptions, textEditUsage } from "../text-edit.js";
import { formatRelations, presentRelations, relationRouter } from "./relation-router.js";
import { commentRouter, formatComments, presentComments } from "./comment-router.js";
import { currentActor } from "../actor.js";
import { resolveProjectKey } from "../project.js";
import { formatSection } from "../presentation/section.js";
import { formatActivityList, presentActivities } from "../presentation/activity-presentation.js";
import {
  formatTaskList,
  formatTaskListWithStatus,
  formatTaskRow,
  presentTask,
} from "../presentation/task-presentation.js";

const editOptions = {
  title: { type: "string" },
  description: { type: "string" },
  ...textEditOptions,
  priority: { type: "string" },
  "add-label": { type: "string", multiple: true },
  "remove-label": { type: "string", multiple: true },
} as const;

// A column is changed with task move, so a guessed --status or --column suggests it with the same task keys.
function suggestTaskMove(args: Array<string>, options: ParseArgsOptionsConfig = {}) {
  const { values, positionals } = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: false,
  });
  const guessedColumn = values.status ?? values.column;
  const columnWords = typeof guessedColumn === "string" ? [guessedColumn] : [];

  return ["task", "move", ...positionals, ...columnWords];
}

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
          column: { type: "string" },
          parent: { type: "string" },
          "depends-on": { type: "string", multiple: true },
          "duplicate-of": { type: "string" },
          related: { type: "string", multiple: true },
        },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens, ["label", "depends-on", "related"]);
      validatePositionals(positionals, ["[<project-key>]"]);

      const projectKey = resolveProjectKey(positionals[0], { required: true })!;
      if (values.title === undefined) {
        quit("A task needs at least a title: use --title");
      }
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
          columnName: values.column,
          relations: parseNewTaskRelations(values),
        },
        currentActor(),
      );
      output(presentTask(createdTask), formatTaskRow);
    },
    help: `Usage: zinn task create [<project-key>] --title <text> [--description <text>] [--priority {low|medium|high|urgent|none}] [--label <name>]... [--column <name>] [--parent <task-key>] [--depends-on <task-key>]... [--duplicate-of <task-key>] [--related <task-key>]...

Create a task at the bottom of a column. Without --column, it starts in the project's first column.

An omitted project key uses defaultProject from settings, if present.
If no default project is set, the key is required.

Column names are matched case-insensitively. An unknown column is an error and creates nothing.
Priority defaults to none (unassigned).
Repeat --label to attach multiple existing labels. Unknown labels are errors.
Label names are matched case-insensitively.
Titles are trimmed and cannot be blank or contain line breaks or control characters.

${dashValueHelp("--description")}

Relations are set from the new task's perspective: it becomes a subtask of --parent, depends on --depends-on,
is a duplicate of --duplicate-of, and is related to --related.
Repeat --depends-on and --related to name several tasks.
A target task that does not exist causes an error, and task creation is aborted.

Examples:
  zinn task create MDR --title 'Refine the numbers' --description 'Meet the quarterly quota' --label urgent
  zinn task create MDR --title 'Review the numbers' --column 'In Progress'
  zinn task create MDR --title 'Sort the files' --parent MDR-1 --depends-on MDR-2`,
  },
  list: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: {
          archived: { type: "boolean" },
          all: { type: "boolean" },
          "all-projects": { type: "boolean" },
          label: { type: "string", multiple: true },
          column: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, ["label"]);
      validatePositionals(positionals, ["[<project-key>]"]);

      if (values.archived && values.all) {
        quit('Use either "--archived" or "--all", not both');
      }

      const projectKey = resolveProjectKey(positionals[0], { allProjects: values["all-projects"] });
      const archive = values.all ? "all" : values.archived ? "archived" : "active";

      const tasks = task.getAll({
        projectKey,
        archive,
        labelNames: values.label,
        columnName: values.column,
      });

      output(tasks.map(presentTask), (presentedTasks) =>
        formatTaskList(presentedTasks, { showsStatus: values.all }),
      );
    },
    help: `Usage: zinn task list [<project-key>|--all-projects] [--archived|--all] [--label <name>]... [--column <name>]

List active tasks by default.
An omitted project key uses defaultProject from settings, if present.
If no default project is set, the command lists every project.
Use --all-projects to list every project, overriding the default. It cannot be combined with a typed project key.
Use --archived to list archived tasks or --all to list both.
Use --label to filter for tasks with a specific label, no case-sensitivity is applied for matching.
Use --column to filter by an exact column name without case sensitivty.
Column, label and archive filters can be combined together. No matches print nothing, or return [] for --json, and exit successfully.

Each row shows a task's key, column, priority marker, title, and labels. --all adds an Active or Archived status after the key.
Priority markers: - unassigned, L low, M medium, H high, U urgent.
Use 'task view' to see a task's full details, including its description.

Example: zinn task list MDR --label cli`,
  },
  search: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: {
          archived: { type: "boolean" },
          all: { type: "boolean" },
          "all-projects": { type: "boolean" },
          limit: { type: "string" },
          label: { type: "string", multiple: true },
        },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, ["label"]);
      validatePositionals(positionals, ["<query>", "[<project-key>]"]);

      const query = positionals[0]!;

      if (values.archived && values.all) {
        quit('Use either "--archived" or "--all", not both');
      }

      const archive = values.all ? "all" : values.archived ? "archived" : "active";
      const limitPattern = new RegExp(`^${positiveIntegerPattern}$`);

      if (values.limit !== undefined && !limitPattern.test(values.limit)) {
        quit(searchLimitMessage);
      }

      const isTaskKeyQuery = parseTaskKey(query.trim()) !== null;
      const projectKey = resolveProjectKey(positionals[1], {
        allProjects: values["all-projects"],
        useDefault: !isTaskKeyQuery,
      });
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      const result = task.search({
        query,
        projectKey,
        archive,
        limit,
        labelNames: values.label,
      });

      output(result.tasks.map(presentTask), (presentedTasks) =>
        formatTaskList(presentedTasks, { showsStatus: values.all }),
      );

      if (result.hiddenArchivedCount > 0) {
        const count = result.hiddenArchivedCount;
        const noun = count === 1 ? "match" : "matches";
        console.error(`${count} archived ${noun} hidden, use --all to include them`);
      }
    },
    help: `Usage: zinn task search <query> [<project-key>|--all-projects] [--archived|--all] [--limit <n>] [--label <name>]...

Search task titles, descriptions, and comments. A comment match lists the task it belongs to.
An omitted project key uses defaultProject from settings, if present.
If no default project is set, the command searches every project.
Use --all-projects to search every project, overriding the default. It cannot be combined with a typed project key.
Each word matches the start of a word, ignoring case and accents: e.g. "auth" finds "Authentication".
Every word must match. Quote a query with several words.

A query that is exactly a task key, such as MDR-1, lists that task first.
If given, a task key query overrides the configured default, and a typed project key still filters the search.
Other results are ordered by relevance, with title matches weighted highest.
Equally relevant tasks are ordered by project key, then task number.

By default, only active tasks are searched. Use --archived to search archived tasks or --all to search both.
When archived matches are hidden, a note is printed to say how many.
Use --limit to show at most <n> results.
Use --label to filter for tasks with a specific label, no case-sensitivity is applied for matching.
A search result's output matches that of 'task list'.

Example: zinn task search 'refinement quota' MDR --limit 5`,
  },
  view: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { history: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens);
      validatePositionals(positionals, ["<task-key>"]);

      const taskMatch = task.getByKey(positionals[0]!);
      const viewedTask = {
        ...presentTask(taskMatch),
        relations: presentRelations(taskMatch),
        comments: presentComments(taskMatch.key),
        ...(values.history === true
          ? {
              activity: task
                .activity(taskMatch.key)
                .sort(
                  (left, right) =>
                    right.created_at - left.created_at || right.id.localeCompare(left.id),
                ),
            }
          : {}),
      };

      output(viewedTask, (t) => {
        const MIN_SECTION_SEPARATOR_WIDTH = 60;

        const terminalWidth = process.stdout.columns;
        const hasTerminalWidth = process.stdout.isTTY === true && terminalWidth > 0;

        const sectionOptions = {
          separatorWidth: hasTerminalWidth ? terminalWidth : MIN_SECTION_SEPARATOR_WIDTH,
        };
        const relations = formatRelations(t.relations);
        const comments = formatComments(t.comments);
        const isArchived = t.status === "Archived";
        const sections = [
          formatTaskList([t], { showsStatus: isArchived, showsFullPriority: true }),
        ];

        if (t.description != null) {
          sections.push(formatSection("Description", t.description, sectionOptions));
        }

        if (relations.length > 0) {
          sections.push(formatSection("Relations", relations, sectionOptions));
        }

        if (comments.length > 0) {
          sections.push(formatSection("Comments", comments, sectionOptions));
        }

        if (t.activity !== undefined) {
          const history = formatActivityList(presentActivities(t.activity));
          if (history.length > 0) {
            sections.push(formatSection("History", history, sectionOptions));
          }
        }

        return sections.join("\n\n");
      });
    },
    help: `Usage: zinn task view <task-key> [--history]

Show a task with its description, relations, and comments.
A section is shown when the task has that content. The description prints in full, keeping its line breaks.
Use --history to include this task's recorded activity, newest first, including reorders and comment changes.
Use activity view <activity-id> for full recorded changes. Text times are local with a UTC offset.
With --history --json, the activity field contains full activity records, or [] when none are recorded.
Without --history, JSON omits activity.

Examples:
  zinn task view MDR-1
  zinn task view MDR-1 --history`,
  },
  edit: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: editOptions,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, ["add-label", "remove-label"]);
      validatePositionals(positionals, ["<task-key>"]);

      const taskKey = positionals[0]!;
      const description = resolveTextEdit(values.description, values, "--description");

      const hasEditFlags =
        values.title !== undefined ||
        description !== undefined ||
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
          description,
          priority: parsePriority(values.priority),
          addLabelNames: values["add-label"],
          removeLabelNames: values["remove-label"],
        },
        currentActor(),
      );

      output(presentTask(editedTask), formatTaskRow);
    },
    help: `Usage: zinn task edit <task-key> [--title <text>] [--description <text> ${textEditUsage}] [--priority {low|medium|high|urgent|none}] [--add-label <name>]... [--remove-label <name>]...

Edit a task's title, description, priority, or label attachments.
Use --priority none to clear priority.
Provide at least one edit flag. Use --description '' to clear the description.

${textEditHelp("--description")}

Repeat --add-label or --remove-label for multiple existing labels.
Label names are matched case-insensitively.
Adding an attached label or removing an unattached label does not do anything.
Archived tasks can be edited.

The same label cannot be both added and removed.
Titles are trimmed and cannot be blank or contain line breaks or control characters.

${dashValueHelp("--description")}

Examples:
  zinn task edit MDR-1 --title 'Meet the quarterly refinement quota'
  zinn task edit MDR-1 --description 'Bring waffles.' --append`,
    guessedFlags: {
      "--status": (args) => suggestTaskMove(args, editOptions),
      "--column": (args) => suggestTaskMove(args, editOptions),
    },
  },
  move: {
    run: (args) => {
      const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
      validatePositionals(positionals, ["<task-key>...", "<target-column>"]);

      const taskKeys = positionals.slice(0, -1);
      const targetColumn = positionals.at(-1)!;
      const moves = task.moveMany({ taskKeys, targetColumn }, currentActor());
      outputTaskChanges(
        moves,
        formatTaskList,
        (movedTask) => `${movedTask.key} was already in the ${movedTask.column} column`,
      );
    },
    help: `Usage: zinn task move <task-key>... <target-column>

Move tasks to another column in their projects.
Moving a task to a different column lists it last in that column,
matching placement at the bottom of a visual kanban column.
Several tasks are moved in the order given, and each task's column is looked up in its own project.

Giving a task's current column as the target will not do anything, and a note says so.
Archived tasks must be unarchived before they can be moved.
On bulk changes, if any task cannot be moved, the bulk operation is aborted.

With --json, one task prints an object and several print an array.
Each task's changed field is 'false' when it was already in the requested state.

Example: zinn task move MDR-1 MDR-2 'In Progress'`,
    guessedFlags: { "--status": suggestTaskMove, "--column": suggestTaskMove },
  },
  order: {
    run: (args) => {
      const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
      /**
       * The words every direction needs. Only whether they are there is checked here,
       *  since the direction decides whether a target task follows.
       */
      const leadingWords = ["<task-key>", "{top|up|down|bottom|before|after}"];
      validatePositionals(positionals.slice(0, leadingWords.length), leadingWords);

      const taskKey = positionals[0]!;
      const direction = positionals[1]!;

      switch (direction) {
        case "before":
        case "after": {
          validatePositionals(positionals, [...leadingWords, "<target-task-key>"]);

          const orderedTask = task.order(
            { taskKey, direction, targetTaskKey: positionals[2]! },
            currentActor(),
          );
          output(presentTask(orderedTask), formatTaskRow);
          return;
        }
        case "top":
        case "up":
        case "down":
        case "bottom": {
          validatePositionals(positionals, leadingWords);

          const orderedTask = task.order({ taskKey, direction }, currentActor());
          output(presentTask(orderedTask), formatTaskRow);
          return;
        }
        default:
          throw new UsageError(`Unknown order direction "${direction}"`);
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
      const taskKeys = parseTaskKeys(args);
      const archives = task.archiveMany(taskKeys, currentActor());
      outputTaskChanges(
        archives,
        formatTaskListWithStatus,
        (archivedTask) => `${archivedTask.key} was already archived`,
      );
    },
    help: `Usage: zinn task archive <task-key>...

Archive tasks so they no longer appear in active task lists.
Archiving an archived task does not do anything.
On bulk changes, if any task cannot be archived, the bulk operation is aborted.

With --json, one task prints an object and several print an array.
Each task's changed field is 'false' when it was already in the requested state.

Example: zinn task archive MDR-1 MDR-2`,
  },
  unarchive: {
    run: (args: Array<string>) => {
      const taskKeys = parseTaskKeys(args);
      const unarchives = task.unarchiveMany(taskKeys, currentActor());
      outputTaskChanges(
        unarchives,
        formatTaskListWithStatus,
        (unarchivedTask) => `${unarchivedTask.key} was already active`,
      );
    },
    help: `Usage: zinn task unarchive <task-key>...

Unarchive tasks at the bottom of their previous columns, in the order given.
Unarchiving an active task does not do anything.
On bulk changes, if any task cannot be unarchived, the bulk operation is aborted.

With --json, one task prints an object and several print an array.
Each task's changed field is 'false' when it was already in the requested state.

Example: zinn task unarchive MDR-1 MDR-2`,
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
      validatePositionals(positionals, ["<task-key>"]);

      const taskKey = positionals[0]!;

      try {
        const taskMatch = task.getByKey(taskKey);
        const canDelete = await confirmAction(
          `Are you sure you want to delete ${taskKey}?`,
          values.yes === true,
        );
        const presented = presentTask(taskMatch);

        if (canDelete) {
          task.delete(taskKey, currentActor());
          output(presented, (t) => `Deleted ${formatTaskRow(t)}`);
        } else {
          output(presented, (t) => `Deletion cancelled for ${formatTaskRow(t)}`);
        }
      } catch (err: any) {
        quit(failureMessage(err, "Something went wrong"));
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
        output(presentTask(task.label.add(props, currentActor())), formatTaskRow);
      },
      help: `Usage: zinn task label add <task-key> <label-name>...

Add existing labels to a task. Label names are matched case-insensitively.
Already attached labels are unchanged.`,
    },
    remove: {
      run: (args) => {
        const props = parseTaskLabelArgs(args);
        output(presentTask(task.label.remove(props, currentActor())), formatTaskRow);
      },
      help: `Usage: zinn task label remove <task-key> <label-name>...

Remove existing labels from a task. Label names are matched case-insensitively.`,
    },
  },
} satisfies RouteDef;

function parseTaskKeys(args: Array<string>) {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  validatePositionals(positionals, ["<task-key>..."]);

  return positionals;
}

/**
 * Prints the changed tasks as rows, or as JSON: an object for one task and an array for several.
 * JSON includes each task's `changed` flag, and each unchanged task also gets a note on stderr.
 */
function outputTaskChanges(
  changes: Array<TaskChange>,
  formatTasks: (presentedTasks: Array<PresentedTask>) => string,
  describeUnchanged: (presentedTask: PresentedTask) => string,
) {
  const presentedChanges = changes.map((change) => ({
    ...presentTask(change.task),
    changed: change.changed,
  }));

  if (presentedChanges.length === 1) {
    output(presentedChanges[0]!, (presentedChange) => formatTasks([presentedChange]));
  } else {
    output(presentedChanges, formatTasks);
  }

  for (const presentedChange of presentedChanges) {
    if (!presentedChange.changed) {
      console.error(describeUnchanged(presentedChange));
    }
  }
}

function parseTaskLabelArgs(args: string[]) {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true });
  validatePositionals(positionals, ["<task-key>", "<label-name>..."]);

  return { taskKey: positionals[0]!, labelNames: positionals.slice(1) };
}

type NewTaskRelationFlags = {
  parent?: string;
  "depends-on"?: Array<string>;
  "duplicate-of"?: string;
  related?: Array<string>;
};

// The new task is the source of each relation, so a flag names the type from its point of view.
function parseNewTaskRelations(flags: NewTaskRelationFlags) {
  const targetsByType: Array<[TaskRelationType, Array<string>]> = [
    ["subtask", flags.parent === undefined ? [] : [flags.parent]],
    ["dependency", flags["depends-on"] ?? []],
    ["duplicate", flags["duplicate-of"] === undefined ? [] : [flags["duplicate-of"]]],
    ["related", flags.related ?? []],
  ];

  return targetsByType.flatMap(([relation_type, targetTaskKeys]) =>
    targetTaskKeys.map((targetTaskKey) => ({ relation_type, targetTaskKey })),
  );
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
