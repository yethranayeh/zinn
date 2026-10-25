import type { PresentedActivity } from "../result-schemas.js";
import type { RouteDef } from "../types.js";
import type { CommandInput } from "../input.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import {
  activity,
  activityActionSchema,
  activityChangedFieldSchema,
  activityChangedSchema,
  activityLimitMessage,
  CoreError,
  positiveIntegerPattern,
} from "@zinn-dev/core";

import { generateCommandUsage, getOptionInputs, violatesConstraint } from "../input.js";
import { CliError } from "../errors.js";
import { output, quit, validatePositionals, validateUniqueOptions } from "../lib.js";
import { formatActivityList, presentActivities } from "../presentation/activity-presentation.js";

const changedFieldList = activityChangedFieldSchema.options.join(", ");

const activityInputs = {
  list: {
    options: {
      project: { type: "string", value: { kind: "project-key", name: "project-key" } },
      "project-id": {
        type: "string",
        value: {
          kind: "project-id",
          name: "project-id",
          description: "Full project UUID; canonical or compact, case-insensitive",
        },
      },
      task: { type: "string", value: { kind: "task-key", name: "task-key" } },
      "task-id": {
        type: "string",
        value: {
          kind: "task-id",
          name: "task-id",
          description: "Full task UUID; canonical or compact, case-insensitive",
        },
      },
      "show-deleted": { type: "boolean" },
      session: { type: "string", value: { kind: "text", name: "id" } },
      thread: { type: "string", value: { kind: "text", name: "id" } },
      action: {
        type: "string",
        multiple: true,
        value: { kind: "activity-action", name: "action", choices: activityActionSchema.options },
      },
      changed: {
        type: "string",
        multiple: true,
        value: {
          kind: "activity-change",
          name: "field[=value]",
          pattern: `^((${activityChangedFieldSchema.options.join("|")})|(${activityChangedFieldSchema.exclude(["title", "description"]).options.join("|")})=.+)$`,
          description: `Fields: ${changedFieldList}. Omit the value to match any change. Values apply to column, priority and added labels, ignoring case. priority=none matches an unassigned priority.`,
        },
      },
      limit: {
        type: "string",
        value: { kind: "positive-integer", name: "n", pattern: `^${positiveIntegerPattern}\\d?$` },
      },
    },
    forms: [{ id: "default", positionals: [] }],
    constraints: [
      {
        kind: "exclusive",
        members: ["option:project", "option:project-id", "option:task", "option:task-id"],
      },
      {
        kind: "requiresAny",
        input: "option:show-deleted",
        members: ["option:project", "option:task"],
      },
    ],
    notes: [
      "Repeated --action flags match any listed action. Repeated --changed filters for one field match any of them. Different fields must match the same event. All other filters must also match, before --limit applies.",
    ],
  },
  view: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [{ name: "activity-id", min: 1, max: 1, value: { kind: "activity-id" } }],
      },
    ],
    constraints: [],
  },
} as const satisfies Record<string, CommandInput>;

export const activityRouter = {
  list: {
    summary: "List recorded activity across the database, newest first.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: activityInputs.list,
    results: [jsonResult("ActivityList")],
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: activityInputs.list.options,
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens, activityInputs.list.options);
      validatePositionals(positionals, activityInputs.list.forms[0]);

      const [selectorConstraint, deletedHistoryConstraint] = activityInputs.list.constraints;
      const optionInputs = getOptionInputs(values);

      if (violatesConstraint(selectorConstraint, optionInputs)) {
        const conflictingSelector = selectorConstraint.members.filter(
          (member) => optionInputs[member] !== undefined,
        )[1]!;

        quit("Use one of --project, --project-id, --task or --task-id", undefined, {
          argument: conflictingSelector.replace("option:", "--"),
        });
      }

      if (violatesConstraint(deletedHistoryConstraint, optionInputs)) {
        quit("--show-deleted requires --project or --task", undefined, {
          argument: "--show-deleted",
        });
      }

      // Safe integers can have one more digit than readable task numbers.
      const limitPattern = new RegExp(activityInputs.list.options.limit.value.pattern);
      if (values.limit !== undefined && !limitPattern.test(values.limit)) {
        quit(activityLimitMessage, undefined, { argument: "--limit" });
      }

      let events: ReturnType<typeof activity.getAll>;
      try {
        events = activity.getAll({
          projectKey: values.project,
          projectId: values["project-id"],
          taskKey: values.task,
          taskId: values["task-id"],
          showDeleted: values["show-deleted"],
          sessionId: values.session,
          threadId: values.thread,
          actions: values.action?.map((action) => {
            const parsed = activityActionSchema.safeParse(action);
            if (!parsed.success) {
              quit(
                `Unknown action "${action}". Use ${activityActionSchema.options.join(", ")}`,
                undefined,
                {
                  argument: "--action",
                },
              );
            }
            return parsed.data;
          }),
          changed: values.changed?.map(parseChangedFilter),
          limit: values.limit === undefined ? undefined : Number(values.limit),
        });
      } catch (error) {
        const isMissingCurrentSelection =
          (values.task !== undefined || values.project !== undefined) &&
          values["show-deleted"] !== true &&
          error instanceof CoreError &&
          error.kind === "missing" &&
          error.facts.entity === (values.project !== undefined ? "project" : "task");

        if (isMissingCurrentSelection) {
          const selector = error.facts.entity === "project" ? "--project" : "--task";
          throw new CliError(
            error.message,
            "not_found",
            {
              entity: error.facts.entity,
              key: error.facts.key,
              source: "explicit",
              argument: selector,
            },
            `Use ${selector} ${values.project ?? values.task} --show-deleted to include deleted history.`,
          );
        }

        throw error;
      }

      output(events, (items) =>
        formatActivityList(
          presentActivities(items, {
            projectKey: values.project,
            projectId: values["project-id"],
            showDeleted: values["show-deleted"],
            taskKey: values.task,
            taskId: values["task-id"],
          }),
        ),
      );
    },
    help: `${generateCommandUsage("activity list", activityInputs.list)}

List recorded activity across the database, newest first.
Returns all matching events unless --limit is supplied.

--task <key>       Select an existing active or archived task.
--project <key>    Select an existing project's activity, including deleted tasks.
--project-id <uuid> Select one project identity, including deleted projects.
                   Requires a full UUID.
--show-deleted     Also include deleted identities sharing the selected key.
--task-id <uuid>   Select one task identity, including deleted tasks.
                   Requires a full UUID.
--session <id>     Match an exact session ID, including case.
--thread <id>      Match an exact thread ID, including case.
--action <action>  Match a recorded action. Repeat to match any listed action.
--changed <field>[=<value>] Match a task field change, with an optional value.
                   Fields: ${changedFieldList}.
                   Values apply to column, priority and added labels, ignoring case.
                   Without a value, labels match additions and removals.
                   Title and description match any change, without a value.
                   Use priority=none for an unassigned priority.
--limit <n>        Return at most n matching events.

Use one of --project, --project-id, --task or --task-id.
--show-deleted requires --project or --task.
Repeated --action flags match any listed action.
Repeated --changed filters for one field match any of them.
Different fields must match the same event. All other filters must also match.
Initial task values also match. Column and label names match as recorded.

Use activity view <activity-id> for complete recorded changes.
With --json, return an array of full activity records.

Examples:
  zinn activity list --limit 10
  zinn activity list --project APP
  zinn activity list --action comment_create --action comment_edit
  zinn activity list --action edit --changed description
  zinn activity list --changed column=Review
  zinn activity list --changed priority=high --changed labels=bug
  zinn activity list --task APP-2
  zinn activity list --task APP-2 --show-deleted`,
  },
  view: {
    summary: "Show one recorded event with full activity/entity IDs, actor and complete changes.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: activityInputs.view,
    results: [jsonResult("Activity")],
    run: (args) => {
      const { positionals } = parseArgs({
        options: activityInputs.view.options,
        args,
        allowPositionals: true,
        strict: true,
      });

      validatePositionals(positionals, activityInputs.view.forms[0]);

      const viewed = activity.getById(positionals[0]!) satisfies PresentedActivity;
      output(viewed, (event) =>
        formatActivityList(presentActivities([event], { showsFullIds: true }), {
          showsDetails: true,
        }),
      );
    },
    help: `${generateCommandUsage("activity view", activityInputs.view)}

Show one recorded event with full activity/entity IDs, actor and complete changes.
Recorded text and line breaks are preserved.

Accept a full UUID or unique left prefix with at least eight hexadecimal digits.
With --json, return one full activity record.

Example: zinn activity view 019abcdf-1234-7`,
  },
} satisfies RouteDef;

function parseChangedFilter(input: string) {
  const separator = input.indexOf("=");
  const field = separator === -1 ? input : input.slice(0, separator);
  const value = input.slice(separator + 1);
  const filter = activityChangedSchema.safeParse(
    separator === -1
      ? { field }
      : {
          field,
          value: field === "priority" && value.toLowerCase() === "none" ? null : value,
        },
  );

  if (!filter.success) {
    quit(filter.error.issues[0]!.message, undefined, { argument: "--changed" });
  }

  return filter.data;
}
