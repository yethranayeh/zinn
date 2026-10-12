import type { RouteDef } from "../types.js";

import { parseArgs } from "node:util";
import { activity, activityLimitMessage, positiveIntegerPattern } from "@zinn-dev/core";
import { output, quit, validatePositionals, validateUniqueOptions } from "../lib.js";
import { formatActivityList, presentActivities } from "../presentation/activity-presentation.js";

export const activityRouter = {
  list: {
    run: (args) => {
      const { values, positionals, tokens } = parseArgs({
        args,
        options: { task: { type: "string" }, limit: { type: "string" } },
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
      validateUniqueOptions(tokens);
      validatePositionals(positionals, []);

      // Safe integers can have one more digit than readable task numbers.
      const limitPattern = new RegExp(`^${positiveIntegerPattern}\\d?$`);
      if (values.limit !== undefined && !limitPattern.test(values.limit)) {
        quit(activityLimitMessage);
      }

      const events = activity.getAll({
        taskKey: values.task,
        limit: values.limit === undefined ? undefined : Number(values.limit),
      });

      output(events, (items) =>
        formatActivityList(presentActivities(items, { taskKey: values.task })),
      );
    },
    help: `Usage: zinn activity list [--task <task-key>] [--limit <n>] [--json]

List recorded activity across the database, newest first.
By default, all matching events are returned. --limit takes a positive safe integer.
--task includes existing, archived and deleted task lifetimes for that key,
including the recorded project deletion that removed a task.
A key reused after project deletion includes every known lifetime.
A valid key without recoverable history returns an empty list.

Text times are local dates/times with a UTC offset.
Event IDs are the shortest globally unique left prefixes of at least eight hex digits.
Use activity view for full recorded changes; full IDs are durable, short prefixes may become ambiguous.
With --json, output is an array of full activity records, with parsed changes or null.
Group JSON records by entity_type and entity_id to distinguish tasks sharing a readable key.
id identifies the activity event.
A project deletion event's entity_id is the project ID and removed task IDs are in changes.tasks.

Examples:
  zinn activity list --limit 10
  zinn activity list --task APP-2 --json`,
  },
  view: {
    run: (args) => {
      const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
      validatePositionals(positionals, ["<activity-id>"]);
      output(activity.getById(positionals[0]!), (event) =>
        formatActivityList(presentActivities([event], { showsFullIds: true }), {
          showsDetails: true,
        }),
      );
    },
    help: `Usage: zinn activity view <activity-id> [--json]

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
