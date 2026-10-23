import type { ParseArgsOptionsConfig } from "node:util";
import type { TaskChange, TaskRelationType } from "@zinn-dev/core";
import type {
  PresentedTask,
  PresentedTaskDetail,
  PresentedTaskDetailHistory,
  PresentedTaskChange,
} from "../result-schemas.js";
import type { RouteDef } from "../types.js";
import type { CommandInput, InputConstraint } from "../input.js";

import { jsonResult, taskDetailResults, taskChangeResults } from "../results.js";
import { parseArgs } from "node:util";
import {
  task,
  project,
  positiveIntegerPattern,
  searchLimitMessage,
  parseTaskKey,
  taskCreateSchema,
  taskEditSchema,
  taskPrioritySchema,
} from "@zinn-dev/core";

import { CliError } from "../errors.js";
import {
  generateCommandUsage,
  taskKeyPositional,
  archiveConstraint,
  getOptionInputs,
  violatesConstraint,
} from "../input.js";
import {
  confirmationDescription,
  confirmAction,
  dashValueHelp,
  diagnostic,
  output,
  quit,
  validatePositionals,
  validateOrderForms,
  requireStringOption,
  validateUniqueOptions,
} from "../lib.js";
import {
  resolveTextEdit,
  textEditHelp,
  textEditOptions,
  textEditConstraints,
} from "../text-edit.js";
import {
  checkFieldsBeforeText,
  resolveTextInput,
  textFileHelp,
  textFileOption,
  textSourceConstraint,
} from "../text-input.js";
import { currentActor } from "../actor.js";
import {
  checkDefaultProject,
  chooseProjectKey,
  resolveProjectKey,
  projectScopeConstraint,
  requiredProjectDescription,
  projectScopeDescription,
} from "../project.js";
import { relationRouter } from "./relation-router.js";
import { commentRouter } from "./comment-router.js";
import { formatRelationList, presentRelations } from "../presentation/relation-presentation.js";
import { formatCommentList, presentComments } from "../presentation/comment-presentation.js";
import { formatSection } from "../presentation/section.js";
import { formatActivityList, presentActivities } from "../presentation/activity-presentation.js";
import { formatTaskList, presentTask } from "../presentation/task-presentation.js";

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

const priorityOption = {
  type: "string",
  value: {
    kind: "enum",
    name: "priority",
    choices: [...taskPrioritySchema.options, "none"],
    caseInsensitive: true,
    description:
      "Omission leaves priority unassigned on creation and unchanged on edit. none clears priority; JSON uses null.",
  },
} as const;

const taskEditConstraint = {
  kind: "atLeastOne",
  members: [
    "option:title",
    "option:description",
    "option:description-file",
    "option:priority",
    "option:add-label",
    "option:remove-label",
  ],
} as const satisfies InputConstraint;

const taskInputs = {
  create: {
    options: {
      title: { type: "string", required: true, value: { kind: "text", name: "text" } },
      description: { type: "string", value: { kind: "text", name: "text" } },
      "description-file": textFileOption,
      priority: priorityOption,
      label: { type: "string", multiple: true, value: { kind: "label-name", name: "name" } },
      column: { type: "string", value: { kind: "column-name", name: "name" } },
      parent: { type: "string", value: { kind: "task-key", name: "task-key" } },
      "depends-on": {
        type: "string",
        multiple: true,
        value: { kind: "task-key", name: "task-key" },
      },
      "duplicate-of": { type: "string", value: { kind: "task-key", name: "task-key" } },
      related: { type: "string", multiple: true, value: { kind: "task-key", name: "task-key" } },
    },
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 0, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [textSourceConstraint("--description")],
    notes: [requiredProjectDescription],
  },
  list: {
    options: {
      archived: { type: "boolean" },
      all: { type: "boolean" },
      "all-projects": { type: "boolean" },
      label: { type: "string", multiple: true, value: { kind: "label-name", name: "name" } },
      column: { type: "string", value: { kind: "column-name", name: "name" } },
    },
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 0, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [archiveConstraint, projectScopeConstraint],
    notes: [projectScopeDescription],
  },
  search: {
    options: {
      archived: { type: "boolean" },
      all: { type: "boolean" },
      "all-projects": { type: "boolean" },
      limit: {
        type: "string",
        value: { kind: "positive-integer", name: "n", pattern: `^${positiveIntegerPattern}$` },
      },
      label: { type: "string", multiple: true, value: { kind: "label-name", name: "name" } },
    },
    forms: [
      {
        id: "default",
        positionals: [
          { name: "query", min: 1, max: 1, value: { kind: "text" } },
          { name: "project-key", min: 0, max: 1, value: { kind: "project-key" } },
        ],
      },
    ],
    constraints: [archiveConstraint, projectScopeConstraint],
    notes: [
      projectScopeDescription,
      "A query that is a task key ignores defaultProject unless a project was typed. --all-projects still excludes a typed project.",
    ],
  },
  view: {
    options: { history: { type: "boolean" } },
    forms: [
      {
        id: "default",
        positionals: [taskKeyPositional],
      },
    ],
    constraints: [],
  },
  edit: {
    options: {
      title: { type: "string", value: { kind: "text", name: "text" } },
      description: { type: "string", value: { kind: "text", name: "text" } },
      "description-file": textFileOption,
      ...textEditOptions,
      priority: priorityOption,
      "add-label": { type: "string", multiple: true, value: { kind: "label-name", name: "name" } },
      "remove-label": {
        type: "string",
        multiple: true,
        value: { kind: "label-name", name: "name" },
      },
    },
    forms: [
      {
        id: "default",
        positionals: [taskKeyPositional],
      },
    ],
    constraints: [
      textSourceConstraint("--description"),
      ...textEditConstraints("--description"),
      taskEditConstraint,
    ],
    notes: [textEditHelp("--description")],
  },
  move: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [
          { ...taskKeyPositional, max: null },
          { name: "target-column", min: 1, max: 1, value: { kind: "column-name" } },
        ],
      },
    ],
    constraints: [],
  },
  order: {
    options: {},
    forms: [
      {
        id: "absolute",
        positionals: [
          taskKeyPositional,
          {
            name: "direction",
            min: 1,
            max: 1,
            value: { kind: "enum", choices: ["top", "up", "down", "bottom"] },
          },
        ],
      },
      {
        id: "relative",
        positionals: [
          taskKeyPositional,
          {
            name: "direction",
            min: 1,
            max: 1,
            value: { kind: "enum", choices: ["before", "after"] },
          },
          { ...taskKeyPositional, name: "target-task-key" },
        ],
      },
    ],
    constraints: [],
  },
  archive: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [{ ...taskKeyPositional, max: null }],
      },
    ],
    constraints: [],
  },
  delete: {
    options: { yes: { type: "boolean" } },
    forms: [
      {
        id: "default",
        positionals: [taskKeyPositional],
      },
    ],
    constraints: [],
  },
  label_add: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [
          taskKeyPositional,
          { name: "label-name", min: 1, max: null, value: { kind: "label-name" } },
        ],
      },
    ],
    constraints: [],
  },
} as const satisfies Record<string, CommandInput>;

export const taskRouter = {
  create: {
    summary:
      "Create a task at the bottom of a column. Without --column, it starts in the project's first column.",
    effects: { domain: "create", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.create,
    results: [jsonResult("Task")],
    run: async (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: taskInputs.create.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens, taskInputs.create.options);
      validatePositionals(positionals, taskInputs.create.forms[0]);

      const projectChoice = chooseProjectKey(positionals[0], { required: true })!;
      const title = requireStringOption(
        taskInputs.create.options.title,
        values.title,
        "title",
        "A task needs at least a title: use --title",
      );
      const priority = parsePriority(values.priority);
      const fields = {
        title,
        priority,
        labelNames: values.label,
        columnName: values.column,
        relations: parseNewTaskRelations(values),
      };
      checkFieldsBeforeText(taskCreateSchema, fields);
      const description = await resolveTextInput(
        values.description,
        values["description-file"],
        "--description",
      );
      checkDefaultProject(projectChoice);

      const projectKey = projectChoice.key;
      const projectMatch = project.getByKey(projectKey);
      if (projectMatch == null) {
        throw new CliError(
          `Project with key "${project.standardizeKey(projectKey)}" does not exist`,
          "not_found",
          { entity: "project", key: project.standardizeKey(projectKey), source: "explicit" },
        );
      }
      const createdTask = task.create(
        { ...fields, project_id: projectMatch.id, description: description ?? null },
        currentActor(),
      );
      output(presentTask(createdTask), (entry) => formatTaskList([entry]));
    },
    help: `${generateCommandUsage("task create", taskInputs.create)}

Create a task at the bottom of a column. Without --column, it starts in the project's first column.

${requiredProjectDescription}

Priority values: ${priorityOption.value.choices.join(", ")}; defaults to none.
Repeat --label to attach multiple existing labels.
${textFileHelp("--description")}

${dashValueHelp("--description")}

The new task is a subtask of --parent, depends on --depends-on,
is a duplicate of --duplicate-of, and is related to --related.
Repeat --depends-on and --related to name several tasks.
Unknown columns, labels or related tasks abort creation.

Examples:
  zinn task create MDR --title 'Refine the numbers' --description 'Meet the quarterly quota' --label urgent
  zinn task create MDR --title 'Review the numbers' --column 'In Progress'
  zinn task create MDR --title 'Sort the files' --parent MDR-1 --depends-on MDR-2`,
  },
  list: {
    summary: "List active tasks by default.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.list,
    results: [jsonResult("TaskList")],
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: taskInputs.list.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, taskInputs.list.options);
      validatePositionals(positionals, taskInputs.list.forms[0]);

      if (violatesConstraint(archiveConstraint, getOptionInputs(values))) {
        quit('Use either "--archived" or "--all", not both', undefined, { argument: "--archived" });
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
    help: `${generateCommandUsage("task list", taskInputs.list)}

List active tasks by default.
${projectScopeDescription}
Use --archived to list archived tasks or --all to list both.
Repeat --label to require every specified label.
--column matches an exact column name. Column and label matching ignore case.
All supplied filters must match.

Use 'task view' to see a task's full details, including its description.

Example: zinn task list MDR --label cli`,
  },
  search: {
    summary:
      "Search task titles, descriptions, and comments. A comment match lists the task it belongs to.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.search,
    results: [jsonResult("TaskList")],
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: taskInputs.search.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, taskInputs.search.options);
      validatePositionals(positionals, taskInputs.search.forms[0]);

      const query = positionals[0]!;

      if (violatesConstraint(archiveConstraint, getOptionInputs(values))) {
        quit('Use either "--archived" or "--all", not both', undefined, { argument: "--archived" });
      }

      const archive = values.all ? "all" : values.archived ? "archived" : "active";
      const limitPattern = new RegExp(taskInputs.search.options.limit.value.pattern);

      if (values.limit !== undefined && !limitPattern.test(values.limit)) {
        quit(searchLimitMessage, undefined, { argument: "--limit" });
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

        diagnostic(`${count} archived ${noun} hidden, use --all to include them`);
      }
    },
    help: `${generateCommandUsage("task search", taskInputs.search)}

Search task titles, descriptions, and comments. A comment match lists the task it belongs to.
${projectScopeDescription}
Each word matches the start of a word, ignoring case and accents: e.g. "auth" finds "Authentication".
Every word must match. Quote a query with several words.

A task-key query overrides the configured default project; a typed project key still filters it.

By default, only active tasks are searched. Use --archived to search archived tasks or --all to search both.
Use --limit to show at most <n> results.
Repeat --label to require every specified label, ignoring case.

Example: zinn task search 'refinement quota' MDR --limit 5`,
  },
  view: {
    summary: "Show a task with its description, relations, and comments.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.view,
    results: taskDetailResults,
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: taskInputs.view.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens, taskInputs.view.options);
      validatePositionals(positionals, taskInputs.view.forms[0]);

      const taskMatch = task.getByKey(positionals[0]!);
      const detail = {
        ...presentTask(taskMatch),
        relations: presentRelations(taskMatch),
        comments: presentComments(taskMatch.key),
      };
      const viewedTask =
        values.history === true
          ? ({
              ...detail,
              activity: task
                .activity(taskMatch.key)
                .sort(
                  (left, right) =>
                    right.created_at - left.created_at || right.id.localeCompare(left.id),
                ),
            } satisfies PresentedTaskDetailHistory)
          : ({ ...detail } satisfies PresentedTaskDetail);

      output(viewedTask, (t) => {
        const MIN_SECTION_SEPARATOR_WIDTH = 60;

        const terminalWidth = process.stdout.columns;
        const hasTerminalWidth = process.stdout.isTTY === true && terminalWidth > 0;

        const sectionOptions = {
          separatorWidth: hasTerminalWidth ? terminalWidth : MIN_SECTION_SEPARATOR_WIDTH,
        };
        const relations = formatRelationList(t.relations);
        const comments = formatCommentList(t.comments);
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

        if ("activity" in t) {
          const history = formatActivityList(presentActivities(t.activity));
          if (history.length > 0) {
            sections.push(formatSection("History", history, sectionOptions));
          }
        }

        return sections.join("\n\n");
      });
    },
    help: `${generateCommandUsage("task view", taskInputs.view)}

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
    summary: "Edit a task's title, description, priority, or label attachments.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.edit,
    results: [jsonResult("Task")],
    run: async (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: taskInputs.edit.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, taskInputs.edit.options);
      validatePositionals(positionals, taskInputs.edit.forms[0]);

      const taskKey = positionals[0]!;
      const fields = {
        taskKey,
        title: values.title,
        priority: parsePriority(values.priority),
        addLabelNames: values["add-label"],
        removeLabelNames: values["remove-label"],
      };
      checkFieldsBeforeText(taskEditSchema, fields);
      const description = await resolveTextEdit(values, "--description");

      // Without a text source nothing was read, so this usage error still comes before any input.
      if (violatesConstraint(taskEditConstraint, getOptionInputs(values))) {
        quit(
          "Provide at least one edit flag: --title, --description, --description-file, --priority, --add-label, or --remove-label",
          undefined,
          { field: [] },
        );
      }

      const editedTask = task.edit({ ...fields, description }, currentActor());

      output(presentTask(editedTask), (entry) => formatTaskList([entry]));
    },
    help: `${generateCommandUsage("task edit", taskInputs.edit)}

Edit a task's title, description, priority, or label attachments.
Use --priority none to clear priority.
Priority values: ${priorityOption.value.choices.join(", ")}.
Provide at least one edit flag. Use --description '' to clear the description.
${textFileHelp("--description")}

${textEditHelp("--description")}

Repeat --add-label or --remove-label for multiple existing labels, ignoring case.
The same label cannot be both added and removed.
Archived tasks can be edited.

${dashValueHelp("--description")}

Examples:
  zinn task edit MDR-1 --title 'Meet the quarterly refinement quota'
  zinn task edit MDR-1 --description 'Bring waffles.' --append`,
    guessedFlags: {
      "--status": (args) => suggestTaskMove(args, taskInputs.edit.options),
      "--column": (args) => suggestTaskMove(args, taskInputs.edit.options),
    },
  },
  move: {
    summary: "Move tasks to another column in their projects.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.move,
    results: taskChangeResults,
    run: (args) => {
      const { positionals } = parseArgs({
        options: taskInputs.move.options,
        args,
        allowPositionals: true,
        strict: true,
      });
      validatePositionals(positionals, taskInputs.move.forms[0]);

      const taskKeys = positionals.slice(0, -1);
      const targetColumn = positionals.at(-1)!;
      const moves = task.moveMany({ taskKeys, targetColumn }, currentActor());
      outputTaskChanges(
        moves,
        formatTaskList,
        (movedTask) => `${movedTask.key} was already in the ${movedTask.column} column`,
      );
    },
    help: `${generateCommandUsage("task move", taskInputs.move)}

Move tasks to another column in their projects.
Moved tasks go to the bottom of the destination column in the order given.
Each task's column is looked up in its own project.

Moving to the current column leaves the task unchanged.
Archived tasks must be unarchived before they can be moved.
If any task cannot be moved, none change.

Example: zinn task move MDR-1 MDR-2 'In Progress'`,
    guessedFlags: { "--status": suggestTaskMove, "--column": suggestTaskMove },
  },
  order: {
    summary: "Change a task's position within its current column.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.order,
    results: [jsonResult("Task")],
    run: (args) => {
      const { positionals } = parseArgs({
        options: taskInputs.order.options,
        args,
        allowPositionals: true,
        strict: true,
      });
      const form = validateOrderForms(positionals, taskInputs.order.forms);
      const taskKey = positionals[0]!;
      if (form.id === "relative") {
        const direction =
          positionals[1] as (typeof form)["positionals"][1]["value"]["choices"][number];
        const orderedTask = task.order(
          { taskKey, direction, targetTaskKey: positionals[2]! },
          currentActor(),
        );
        output(presentTask(orderedTask), (entry) => formatTaskList([entry]));
      } else {
        const direction =
          positionals[1] as (typeof form)["positionals"][1]["value"]["choices"][number];
        const orderedTask = task.order({ taskKey, direction }, currentActor());
        output(presentTask(orderedTask), (entry) => formatTaskList([entry]));
      }
    },
    help: `${generateCommandUsage("task order", taskInputs.order)}

Change a task's position within its current column.
Use top or bottom for either end, up or down for one position,
or before or after to place it relative to another task.

Example: zinn task order MDR-2 before MDR-1`,
  },
  archive: {
    summary: "Archive tasks so they no longer appear in active task lists.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.archive,
    results: taskChangeResults,
    run: (args: Array<string>) => {
      const taskKeys = parseTaskKeys(args);
      const archives = task.archiveMany(taskKeys, currentActor());
      outputTaskChanges(
        archives,
        (entries) => formatTaskList(entries, { showsStatus: true }),
        (archivedTask) => `${archivedTask.key} was already archived`,
      );
    },
    help: `${generateCommandUsage("task archive", taskInputs.archive)}

Archive tasks so they no longer appear in active task lists.
Archiving an archived task does not do anything.
On bulk changes, if any task cannot be archived, the bulk operation is aborted.

With --json, one task prints an object and several print an array.
Each task's changed field is 'false' when it was already in the requested state.

Example: zinn task archive MDR-1 MDR-2`,
  },
  unarchive: {
    summary: "Unarchive tasks at the bottom of their previous columns, in the order given.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.archive,
    results: taskChangeResults,
    run: (args: Array<string>) => {
      const taskKeys = parseTaskKeys(args);
      const unarchives = task.unarchiveMany(taskKeys, currentActor());
      outputTaskChanges(
        unarchives,
        (entries) => formatTaskList(entries, { showsStatus: true }),
        (unarchivedTask) => `${unarchivedTask.key} was already active`,
      );
    },
    help: `${generateCommandUsage("task unarchive", taskInputs.archive)}

Unarchive tasks at the bottom of their previous columns, in the order given.
Unarchiving an active task does not do anything.
On bulk changes, if any task cannot be unarchived, the bulk operation is aborted.

With --json, one task prints an object and several print an array.
Each task's changed field is 'false' when it was already in the requested state.

Example: zinn task unarchive MDR-1 MDR-2`,
  },
  delete: {
    summary: "Permanently delete a task after confirmation.",
    effects: { domain: "delete", storage: "normal-open" },
    confirmation: { kind: "prompt", description: confirmationDescription },
    input: taskInputs.delete,
    results: [jsonResult("Task")],
    run: async (args: Array<string>) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: taskInputs.delete.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens, taskInputs.delete.options);
      validatePositionals(positionals, taskInputs.delete.forms[0]);

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
          output(presented, (t) => `Deleted ${formatTaskList([t])}`);
        } else {
          output(presented, (t) => `Deletion cancelled for ${formatTaskList([t])}`);
        }
      } catch (err) {
        throw err;
      }
    },
    help: `${generateCommandUsage("task delete", taskInputs.delete)}

Permanently delete a task after confirmation.
Use --yes to skip the confirmation prompt, for example in scripts or with --json.

Example: zinn task delete MDR-1`,
  },
  relation: relationRouter,
  comment: commentRouter,
  label: {
    add: {
      summary: "Add existing labels to a task. Label names are matched case-insensitively.",
      effects: { domain: "update", storage: "normal-open" },
      confirmation: { kind: "none" },
      input: taskInputs.label_add,
      results: [jsonResult("Task")],
      run: (args) => {
        const props = parseTaskLabelArgs(args);
        output(presentTask(task.label.add(props, currentActor())), (entry) =>
          formatTaskList([entry]),
        );
      },
      help: `${generateCommandUsage("task label add", taskInputs.label_add)}

Add existing labels to a task. Label names are matched case-insensitively.
Already attached labels are unchanged.`,
    },
    remove: {
      summary: "Remove existing labels from a task. Label names are matched case-insensitively.",
      effects: { domain: "update", storage: "normal-open" },
      confirmation: { kind: "none" },
      input: taskInputs.label_add,
      results: [jsonResult("Task")],
      run: (args) => {
        const props = parseTaskLabelArgs(args);
        output(presentTask(task.label.remove(props, currentActor())), (entry) =>
          formatTaskList([entry]),
        );
      },
      help: `${generateCommandUsage("task label remove", taskInputs.label_add)}

Remove existing labels from a task. Label names are matched case-insensitively.`,
    },
  },
} satisfies RouteDef;

function parseTaskKeys(args: Array<string>) {
  const { positionals } = parseArgs({
    options: taskInputs.archive.options,
    args,
    allowPositionals: true,
    strict: true,
  });

  validatePositionals(positionals, taskInputs.archive.forms[0]);

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
  const presentedChanges = changes.map((change) => {
    const presentedTask = presentTask(change.task);
    return {
      key: presentedTask.key,
      status: presentedTask.status,
      column: presentedTask.column,
      title: presentedTask.title,
      description: presentedTask.description,
      priority: presentedTask.priority,
      labels: presentedTask.labels,
      changed: change.changed,
    } satisfies PresentedTaskChange;
  });

  if (presentedChanges.length === 1) {
    output(presentedChanges[0]!, (presentedChange) => formatTasks([presentedChange]));
  } else {
    output(presentedChanges, formatTasks);
  }

  for (const presentedChange of presentedChanges) {
    if (!presentedChange.changed) {
      diagnostic(describeUnchanged(presentedChange));
    }
  }
}

function parseTaskLabelArgs(args: string[]) {
  const { positionals } = parseArgs({
    options: taskInputs.label_add.options,
    args,
    strict: true,
    allowPositionals: true,
  });

  validatePositionals(positionals, taskInputs.label_add.forms[0]);

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
  const normalizedPriority = value?.toLowerCase();
  if (normalizedPriority === undefined) {
    return undefined;
  }

  if (normalizedPriority === "none") {
    return null;
  }

  const priority = taskPrioritySchema.safeParse(normalizedPriority);
  if (!priority.success) {
    quit("Priority must be low, medium, high, urgent, or none", undefined, {
      argument: "--priority",
    });
  }

  return priority.data;
}
