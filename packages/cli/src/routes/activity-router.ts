import type { PresentedActivity } from "../result-schemas.js";
import type { RouteDef } from "../types.js";
import type { CommandInput } from "../input.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import { activity, activityLimitMessage, CoreError, positiveIntegerPattern } from "@zinn-dev/core";

import { generateCommandUsage, getOptionInputs, violatesConstraint } from "../input.js";
import { CliError } from "../errors.js";
import { output, quit, validatePositionals, validateUniqueOptions } from "../lib.js";
import { formatActivityList, presentActivities } from "../presentation/activity-presentation.js";

const activityInputs = {
  list: {
    options: {
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
      limit: {
        type: "string",
        value: { kind: "positive-integer", name: "n", pattern: `^${positiveIntegerPattern}\\d?$` },
      },
    },
    forms: [{ id: "default", positionals: [] }],
    constraints: [
      { kind: "exclusive", members: ["option:task", "option:task-id"] },
      { kind: "requires", input: "option:show-deleted", requires: "option:task" },
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

      const [taskSelectorConstraint, deletedHistoryConstraint] = activityInputs.list.constraints;
      const optionInputs = getOptionInputs(values);

      if (violatesConstraint(taskSelectorConstraint, optionInputs)) {
        quit("Use either --task or --task-id", undefined, { argument: "--task-id" });
      }

      if (violatesConstraint(deletedHistoryConstraint, optionInputs)) {
        quit("--show-deleted requires --task", undefined, { argument: "--show-deleted" });
      }

      // Safe integers can have one more digit than readable task numbers.
      const limitPattern = new RegExp(activityInputs.list.options.limit.value.pattern);
      if (values.limit !== undefined && !limitPattern.test(values.limit)) {
        quit(activityLimitMessage, undefined, { argument: "--limit" });
      }

      let events: ReturnType<typeof activity.getAll>;
      try {
        events = activity.getAll({
          taskKey: values.task,
          taskId: values["task-id"],
          showDeleted: values["show-deleted"],
          sessionId: values.session,
          threadId: values.thread,
          limit: values.limit === undefined ? undefined : Number(values.limit),
        });
      } catch (error) {
        const isMissingCurrentTask =
          values.task !== undefined &&
          values["show-deleted"] !== true &&
          error instanceof CoreError &&
          error.kind === "missing" &&
          error.facts.entity === "task";

        if (isMissingCurrentTask) {
          throw new CliError(
            error.message,
            "not_found",
            { entity: "task", key: error.facts.key, source: "explicit", argument: "--task" },
            `Use --task ${values.task} --show-deleted to include deleted task history.`,
          );
        }

        throw error;
      }

      output(events, (items) =>
        formatActivityList(
          presentActivities(items, { taskKey: values.task, taskId: values["task-id"] }),
        ),
      );
    },
    help: `${generateCommandUsage("activity list", activityInputs.list)}

List recorded activity across the database, newest first.
Returns all matching events unless --limit is supplied.

--task <key>       Select an existing active or archived task.
--show-deleted     Also include deleted tasks sharing that key.
--task-id <uuid>   Select one task identity, including deleted tasks.
                   Requires a full UUID.
--session <id>     Match an exact session ID, including case.
--thread <id>      Match an exact thread ID, including case.
--limit <n>        Return at most n matching events.

Use either --task or --task-id. --show-deleted requires --task.
All supplied filters must match.

Use activity view <activity-id> for complete recorded changes.
With --json, return an array of full activity records.

Examples:
  zinn activity list --limit 10
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
