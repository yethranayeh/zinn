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
By default, all matching events are returned. --limit takes a positive safe integer.
--task selects the existing active or archived task; a missing task is an error.
Add --show-deleted to include every recoverable existing/deleted identity sharing the key.
--task-id selects one exact task identity, including deleted tasks.
Task IDs accept full case-insensitive UUIDs with canonical hyphens or 32 hex digits, without prefixes.
--task and --task-id are mutually exclusive; --show-deleted requires --task.
Historical selection includes the original project deletion whose snapshot contains the task.
A valid task ID or --show-deleted query without recorded matches returns an empty list.
--session and --thread match the complete stored IDs exactly, including case.
All supplied filters must match; --limit applies afterwards.

Text times are local dates/times with a UTC offset.
Event IDs are the shortest globally unique left prefixes of at least eight hex digits.
Use activity view for full recorded changes; full IDs are durable, short prefixes may become ambiguous.
With --json, output is an array of full activity records, with parsed changes or null.
Group JSON records by entity_type and entity_id to distinguish tasks sharing a readable key.
id identifies the activity event.
A project deletion event's entity_id is the project ID and removed task IDs are in changes.tasks.

Examples:
  zinn activity list --limit 10
  zinn activity list --task APP-2 --json
  zinn activity list --task APP-2 --show-deleted
  zinn activity list --task-id 019abcdf-1234-7000-8000-123456abcdef
  zinn activity list --session conversation-id --thread child-thread-id`,
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
Text and line breaks are preserved; unknown change fields remain available as raw JSON.
Text times are local dates/times with a UTC offset.

Accept a full UUID or unique left prefix with at least eight hexadecimal digits.
Matching ignores case and accepts canonical hyphens or uninterrupted hexadecimal digits.
An ambiguous prefix lists candidate IDs and requires more characters.
With --json, output is one full activity record, with parsed changes or null.
id identifies this event itself, while entity_type and entity_id identify its affected entity.

Example: zinn activity view 019abcdf-1234-7`,
  },
} satisfies RouteDef;
