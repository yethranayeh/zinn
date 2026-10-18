import type { PresentedActivity } from "../result-schemas.js";
import type { RouteDef } from "../types.js";
import type { CommandInput } from "../input.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import { activity, activityLimitMessage, positiveIntegerPattern } from "@zinn-dev/core";

import { generateCommandUsage } from "../input.js";
import { output, quit, validatePositionals, validateUniqueOptions } from "../lib.js";
import { formatActivityList, presentActivities } from "../presentation/activity-presentation.js";

const activityInputs = {
  list: {
    options: {
      task: { type: "string", value: { kind: "task-key", name: "task-key" } },
      session: { type: "string", value: { kind: "text", name: "id" } },
      thread: { type: "string", value: { kind: "text", name: "id" } },
      limit: {
        type: "string",
        value: { kind: "positive-integer", name: "n", pattern: `^${positiveIntegerPattern}\\d?$` },
      },
    },
    forms: [{ id: "default", positionals: [] }],
    constraints: [],
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

      // Safe integers can have one more digit than readable task numbers.
      const limitPattern = new RegExp(activityInputs.list.options.limit.value.pattern);
      if (values.limit !== undefined && !limitPattern.test(values.limit)) {
        quit(activityLimitMessage, undefined, { argument: "--limit" });
      }

      const events = activity.getAll({
        taskKey: values.task,
        sessionId: values.session,
        threadId: values.thread,
        limit: values.limit === undefined ? undefined : Number(values.limit),
      }) satisfies Array<PresentedActivity>;

      output(events, (items) =>
        formatActivityList(presentActivities(items, { taskKey: values.task })),
      );
    },
    help: `${generateCommandUsage("activity list", activityInputs.list)}

List recorded activity across the database, newest first.
By default, all matching events are returned. --limit takes a positive safe integer.
--task includes existing, archived and deleted task lifetimes for that key,
including the recorded project deletion that removed a task.
A key reused after project deletion includes every known lifetime.
A valid key without recoverable history returns an empty list.
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
