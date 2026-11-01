import type { ParseArgsOptionsConfig } from "node:util";
import type { TaskRelationType } from "@zinn-dev/core";
import type { PresentedTaskDetail, PresentedTaskDetailHistory } from "../result-schemas.js";
import type { RouteDef } from "../types.js";
import type { CommandInput, InputConstraint } from "../input.js";

import { jsonResult, taskDetailResults, taskChangeResults } from "../results.js";
import { parseArgs } from "node:util";
import {
  task,
  project,
  parseTaskKey,
  taskCreateSchema,
  taskEditSchema,
  taskDeleteManySchema,
  taskPrioritySchema,
  taskSortSchema,
} from "@zinn-dev/core";

import { listLimitOption, listLimitDescription, parseListLimit } from "../list-limit.js";
import { formatListContinuation } from "../list-continuation.js";
import { parseTimestampInput } from "../timestamp-input.js";
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
  outputChanges,
  quit,
  validatePositionals,
  validateOrderForms,
  requireStringOption,
  renameFlag,
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
import { createColumnBoard } from "../presentation/column-presentation.js";
import {
  formatTaskList,
  formatTaskTimestamps,
  presentTask,
} from "../presentation/task-presentation.js";

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

const dueOption = {
  type: "string",
  value: {
    kind: "timestamp",
    name: "timestamp",
    description:
      "Integer epoch milliseconds or YYYY-MM-DDTHH:mm:ss[.SSS] with Z or a numeric offset. Fractions have 1 to 3 digits. none clears the deadline, ignoring case. Omission leaves it unset on creation and unchanged on edit.",
  },
} as const;

const deadlineFilterOptions = {
  "due-since": {
    type: "string",
    value: {
      kind: "timestamp",
      name: "timestamp",
      description:
        "Inclusive lower deadline bound. Integer epoch milliseconds or a timestamp with seconds and Z or a numeric offset. Fractions have 1 to 3 digits. Undated tasks do not match.",
    },
  },
  "due-until": {
    type: "string",
    value: {
      kind: "timestamp",
      name: "timestamp",
      description:
        "Inclusive upper deadline bound in the same formats as --due-since. Must be at or after --due-since. Undated tasks do not match.",
    },
  },
} as const;

const deadlineHelp =
  "--due accepts integer epoch milliseconds or YYYY-MM-DDTHH:mm:ss[.SSS] with Z or a numeric offset such as +01:00. Fractional seconds have 1 to 3 digits. Use --due none to clear it. Omission leaves it unset on creation and unchanged on edit.";
const deadlineFilterHelp =
  "--due-since and --due-until select deadlines inclusively, using integer epoch milliseconds or timestamps with seconds and Z or a numeric offset. Fractional seconds have 1 to 3 digits. Either bound may appear alone. --due-until must be at or after --due-since. Undated tasks do not match. All filters apply before --limit.";

const taskEditConstraint = {
  kind: "atLeastOne",
  members: [
    "option:title",
    "option:description",
    "option:description-file",
    "option:priority",
    "option:due",
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
      due: dueOption,
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
      ...deadlineFilterOptions,
      limit: listLimitOption,
      sort: {
        type: "string",
        value: { kind: "enum", name: "key", choices: taskSortSchema.options },
      },
      archived: { type: "boolean" },
      all: { type: "boolean" },
      "all-projects": { type: "boolean" },
      label: { type: "string", multiple: true, value: { kind: "label-name", name: "name" } },
      column: { type: "string", value: { kind: "column-name", name: "name" } },
      "starting-after": {
        type: "string",
        value: {
          kind: "task-cursor",
          name: "cursor",
          description:
            "Cursor from the continuation command that task list prints on stderr when more tasks remain",
        },
      },
    },
    forms: [
      {
        id: "default",
        positionals: [{ name: "project-key", min: 0, max: 1, value: { kind: "project-key" } }],
      },
    ],
    constraints: [archiveConstraint, projectScopeConstraint],
    notes: [
      projectScopeDescription,
      "A --starting-after cursor works only with the --sort it was made for. Filters may change between pages.",
    ],
  },
  search: {
    options: {
      ...deadlineFilterOptions,
      archived: { type: "boolean" },
      all: { type: "boolean" },
      "all-projects": { type: "boolean" },
      limit: listLimitOption,
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
      due: dueOption,
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
          { ...taskKeyPositional, max: null },
          {
            name: "direction",
            min: 1,
            max: 1,
            value: { kind: "enum", choices: ["top", "bottom"] },
          },
        ],
      },
      {
        id: "step",
        positionals: [
          taskKeyPositional,
          { name: "direction", min: 1, max: 1, value: { kind: "enum", choices: ["up", "down"] } },
        ],
      },
      {
        id: "relative",
        positionals: [
          { ...taskKeyPositional, max: null },
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
        positionals: [{ ...taskKeyPositional, max: null }],
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
    guessedFlags: {
      "--status": (args) => [
        "task",
        "create",
        ...renameFlag(args, taskInputs.create.options, "status", "column"),
      ],
      "--body": (args) => [
        "task",
        "create",
        ...renameFlag(args, taskInputs.create.options, "body", "description"),
      ],
    },
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
        due_at: parseDue(values.due),
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
${deadlineHelp}
Repeat --label to attach multiple existing labels.
${textFileHelp("--description")}

${dashValueHelp("--description")}

The new task is a subtask of --parent, depends on --depends-on,
is a duplicate of --duplicate-of, and is related to --related.
Repeat --depends-on and --related to name several tasks.
Each target may have one relation type. Identical repeated requests count once.
Different relation types for the same target abort creation.
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

      const limit = parseListLimit(values.limit);
      const sort = taskSortSchema.optional().safeParse(values.sort);
      if (!sort.success) {
        quit(`Unknown sort "${values.sort}". Use ${taskSortSchema.options.join(", ")}`, undefined, {
          argument: "--sort",
        });
      }

      const page = task.getPage({
        ...parseDeadlineFilters(values),
        limit,
        sort: sort.data,
        projectKey,
        archive,
        labelNames: values.label,
        columnName: values.column,
        startingAfter: values["starting-after"],
      });

      const board = createColumnBoard();
      output(page.tasks.map((taskMatch) => presentTask(taskMatch, board)), (presentedTasks) =>
        formatTaskList(presentedTasks, { showsStatus: values.all }),
      );

      if (page.nextCursor !== undefined) {
        const selectionTokens = tokens.filter(
          (token) => token.kind !== "option" || token.name !== "all-projects",
        );

        const projectScope = projectKey === undefined ? ["--all-projects"] : [projectKey];
        diagnostic(
          `More tasks. Continue with: ${formatListContinuation(
            ["task", "list"],
            projectScope,
            selectionTokens,
            "starting-after",
            page.nextCursor,
          )}`,
        );
      }
    },
    help: `${generateCommandUsage("task list", taskInputs.list)}

List active tasks by default.
${projectScopeDescription}
Use --archived to list archived tasks or --all to list both.
Repeat --label to require every specified label.
--column matches an exact column name. Column and label matching ignore case.
All supplied filters must match.
--sort activity lists the most recently active tasks first, including comments and relations.
Equal activity times keep board order. Without --sort, board order is preserved.
--sort due lists earliest deadlines first, with undated tasks last. Equal deadlines keep board order. Task positions stay unchanged.
${deadlineFilterHelp}
--limit <n>: ${listLimitDescription}
When additional matches remain after --limit, stderr gives a shell-quoted command to continue, including with --json.
--starting-after <cursor>: Continue after the position a cursor records. Copy the cursor from that command.
A cursor works only with the --sort it was made for. Changes to other tasks between commands can still cause repeats or skips.

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

      const isTaskKeyQuery = parseTaskKey(query.trim()) !== null;
      const projectKey = resolveProjectKey(positionals[1], {
        allProjects: values["all-projects"],
        useDefault: !isTaskKeyQuery,
      });
      const limit = parseListLimit(values.limit);
      const result = task.search({
        ...parseDeadlineFilters(values),
        query,
        projectKey,
        archive,
        limit,
        labelNames: values.label,
      });

      const board = createColumnBoard();
      output(result.tasks.map((taskMatch) => presentTask(taskMatch, board)), (presentedTasks) =>
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
--limit <n>: ${listLimitDescription}
Repeat --label to require every specified label, ignoring case.
${deadlineFilterHelp}

Example: zinn task search 'refinement quota' MDR --limit 5`,
  },
  view: {
    summary:
      "Show a task with its description, relations, comments, and creation and update times.",
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
      const board = createColumnBoard();
      const detail = {
        ...presentTask(taskMatch, board),
        relations: presentRelations(taskMatch, board),
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
          const history = formatActivityList(
            presentActivities(t.activity, { keysFromEventsOnly: true }),
          );
          if (history.length > 0) {
            sections.push(formatSection("History", history, sectionOptions));
          }
        }

        sections.push(formatTaskTimestamps(t));
        return sections.join("\n\n");
      });
    },
    help: `${generateCommandUsage("task view", taskInputs.view)}

Show a task with its description, relations, comments, and creation and update times.
A section is shown when the task has that content. The description prints in full, keeping its line breaks.
Task update time advances for edits, label attachment changes, moves, reorders, archiving and unarchiving.
With --json, created_at and updated_at are stored epoch milliseconds.
Use --history to include this task's recorded activity, newest first, including reorders and comment changes.
Use activity view <activity-id> for full recorded changes. Text times are local with a UTC offset.
With --history --json, the activity field contains full activity records, or [] when none are recorded.
Without --history, JSON omits activity.

Examples:
  zinn task view MDR-1
  zinn task view MDR-1 --history`,
  },
  edit: {
    summary: "Edit a task's title, description, priority, deadline, or label attachments.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.edit,
    results: [jsonResult("TaskChange")],
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
        due_at: parseDue(values.due),
        addLabelNames: values["add-label"],
        removeLabelNames: values["remove-label"],
      };
      checkFieldsBeforeText(taskEditSchema, fields);
      const description = await resolveTextEdit(values, "--description");

      // Without a text source nothing was read, so this usage error still comes before any input.
      if (violatesConstraint(taskEditConstraint, getOptionInputs(values))) {
        quit(
          "Provide at least one edit flag: --title, --description, --description-file, --priority, --due, --add-label, or --remove-label",
          undefined,
          { field: [] },
        );
      }

      const editedTask = task.edit({ ...fields, description }, currentActor());
      const board = createColumnBoard();

      outputChanges(
        [editedTask],
        (change) => presentTask(change.task, board),
        formatTaskList,
        (entry) => `${entry.key} was unchanged`,
      );
    },
    help: `${generateCommandUsage("task edit", taskInputs.edit)}

Edit a task's title, description, priority, deadline, or label attachments.
${deadlineHelp}
Use --priority none to clear priority.
Priority values: ${priorityOption.value.choices.join(", ")}.
Provide at least one edit flag. Use --description '' to clear the description.
${textFileHelp("--description")}

${textEditHelp("--description")}

Repeat --add-label or --remove-label for multiple existing labels, ignoring case.
The same label cannot be both added and removed.
Archived tasks can be edited.
With --json, changed is false when all supplied values already match.

${dashValueHelp("--description")}

Examples:
  zinn task edit MDR-1 --title 'Meet the quarterly refinement quota'
  zinn task edit MDR-1 --description 'Bring waffles.' --append`,
    guessedFlags: {
      "--status": (args) => suggestTaskMove(args, taskInputs.edit.options),
      "--column": (args) => suggestTaskMove(args, taskInputs.edit.options),
      "--body": (args) => [
        "task",
        "edit",
        ...renameFlag(args, taskInputs.edit.options, "body", "description"),
      ],
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
      const board = createColumnBoard();
      outputChanges(
        moves,
        (change) => presentTask(change.task, board),
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
    summary: "Change task positions within their current column.",
    effects: { domain: "update", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: taskInputs.order,
    results: taskChangeResults,
    run: (args) => {
      const { positionals } = parseArgs({
        options: taskInputs.order.options,
        args,
        allowPositionals: true,
        strict: true,
      });
      const form = validateOrderForms(positionals, taskInputs.order.forms);
      const taskKeys = positionals.slice(0, form.directionIndex);
      let orders: ReturnType<typeof task.orderMany>;

      if (form.id === "relative") {
        orders = task.orderMany(
          {
            taskKeys,
            direction: form.direction,
            targetTaskKey: positionals[form.directionIndex + 1]!,
          },
          currentActor(),
        );
      } else {
        orders = task.orderMany({ taskKeys, direction: form.direction }, currentActor());
      }
      const board = createColumnBoard();
      outputChanges(
        orders,
        (change) => presentTask(change.task, board),
        formatTaskList,
        (entry) => `${entry.key} was already in that position`,
      );
    },
    help: `${generateCommandUsage("task order", taskInputs.order)}

Change task positions within their current column.
Order the first task as requested, then each next task after the one before it.
Use top or bottom for either end, or before or after for placement relative to another task.
Up and down take one task and move it one position.
Several tasks must be distinct active tasks in the same project and column. Their target cannot be among them.
Ordering to the current position, or before or after itself, leaves the task unchanged.
With --json, one task prints an object and several an array. Changed is false for an unchanged step.

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
      const board = createColumnBoard();
      outputChanges(
        archives,
        (change) => presentTask(change.task, board),
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
      const board = createColumnBoard();
      outputChanges(
        unarchives,
        (change) => presentTask(change.task, board),
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
    summary: "Permanently delete tasks after confirmation.",
    effects: { domain: "delete", storage: "normal-open" },
    confirmation: { kind: "prompt", description: confirmationDescription },
    input: taskInputs.delete,
    results: [
      jsonResult("Task", { kind: "positionalCount", name: "task-key", min: 1, max: 1 }),
      jsonResult("TaskList", { kind: "positionalCount", name: "task-key", min: 2, max: null }),
    ],
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

      const taskKeys = taskDeleteManySchema.parse(positionals);
      const taskMatches = taskKeys.map((taskKey) => task.getByKey(taskKey));
      const board = createColumnBoard();
      const presented = taskMatches.map((taskMatch) => presentTask(taskMatch, board));
      const canDelete = await confirmAction(
        `Are you sure you want to delete ${taskMatches.map((match) => match.key).join(", ")}?`,
        values.yes === true,
      );

      if (canDelete) {
        task.deleteMany(taskKeys, currentActor());
      }

      output(presented.length === 1 ? presented[0]! : presented, (entries) =>
        formatTaskList(Array.isArray(entries) ? entries : [entries], {
          prefix: canDelete ? "Deleted " : "Deletion cancelled for ",
        }),
      );
    },
    help: `${generateCommandUsage("task delete", taskInputs.delete)}

Permanently delete one or more tasks, including archived tasks, after one confirmation.
Give task keys from any project, separated by space. If any of the tasks cannot be deleted, none are deleted.
Every key must exist and be distinct, ignoring case, before confirmation.
Use --yes to skip the confirmation prompt, for example in scripts or with --json.
With --json, one task prints an object and several an array.

Example: zinn task delete MDR-1 MDR-2`,
  },
  relation: relationRouter,
  comment: commentRouter,
  label: {
    add: {
      summary: "Add existing labels to a task. Label names are matched case-insensitively.",
      effects: { domain: "update", storage: "normal-open" },
      confirmation: { kind: "none" },
      input: taskInputs.label_add,
      results: [jsonResult("TaskChange")],
      run: (args) => {
        const props = parseTaskLabelArgs(args);
        const board = createColumnBoard();
        outputChanges(
          [task.label.add(props, currentActor())],
          (change) => presentTask(change.task, board),
          formatTaskList,
          (entry) => `${entry.key} already had those labels`,
        );
      },
      help: `${generateCommandUsage("task label add", taskInputs.label_add)}

Add existing labels to a task. Label names are matched case-insensitively.
Already attached labels are unchanged.
With --json, changed is false when all the labels were already attached.`,
    },
    remove: {
      summary: "Remove existing labels from a task. Label names are matched case-insensitively.",
      effects: { domain: "update", storage: "normal-open" },
      confirmation: { kind: "none" },
      input: taskInputs.label_add,
      results: [jsonResult("TaskChange")],
      run: (args) => {
        const props = parseTaskLabelArgs(args);
        const board = createColumnBoard();
        outputChanges(
          [task.label.remove(props, currentActor())],
          (change) => presentTask(change.task, board),
          formatTaskList,
          (entry) => `${entry.key} had none of those labels`,
        );
      },
      help: `${generateCommandUsage("task label remove", taskInputs.label_add)}

Remove existing labels from a task. Label names are matched case-insensitively.
Labels that are not attached are unchanged.
With --json, changed is false when none of the labels were attached.`,
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

function parseDue(value: string | undefined) {
  return value?.toLowerCase() === "none" ? null : parseTimestampInput(value, "--due");
}

function parseDeadlineFilters(values: { "due-since"?: string; "due-until"?: string }) {
  const dueSince = parseTimestampInput(values["due-since"], "--due-since");
  const dueUntil = parseTimestampInput(values["due-until"], "--due-until");
  const hasReversedBounds = dueSince !== undefined && dueUntil !== undefined && dueSince > dueUntil;
  if (hasReversedBounds) {
    quit("--due-until must be at or after --due-since", undefined, { argument: "--due-until" });
  }

  return { dueSince, dueUntil };
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
