import type { RouteDef } from "../types";

import { parseArgs } from "node:util";
import { relation, relationCreateSchema, task } from "@zinn-dev/core";
import { quit, validatePositionalCount, validateUniqueOptions } from "../lib";

export function formatRelations(taskKey: string) {
  const taskMatch = task.getByKey(taskKey);

  return relation
    .getAll(taskKey, { include: { tasks: true } })
    .map((entry) => {
      const isSource = entry.source_task_id === taskMatch.id;
      const other = isSource ? entry.target : entry.source;
      if (other == null) {
        throw new Error("Connected task details were not included in the relation");
      }

      let label: string;
      switch (entry.relation_type) {
        case "related": {
          label = "Related to";
          break;
        }
        case "dependency": {
          label = isSource ? "Depends on" : "Depended on by";
          break;
        }
        case "duplicate": {
          label = isSource ? "Duplicate of" : "Duplicated by";
          break;
        }
      }

      const archived = other.archived_at == null ? "" : " | Archived";
      return `${label} | ${other.key} | ${other.title}${archived}`;
    })
    .join("\n");
}

function parseRelationArgs(args: string[]) {
  const { values, positionals, tokens } = parseArgs({
    args,
    options: { type: { type: "string" } },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  validatePositionalCount(positionals, 2, "Exactly two task keys are required: source, target");

  validateUniqueOptions(tokens);

  const typeResult = relationCreateSchema.shape.relation_type.safeParse(values.type);

  if (!typeResult.success) {
    quit("--type must be one of these: related, dependency, duplicate");
  }
  const sourceTaskKey = positionals[0]!;
  const targetTaskKey = positionals[1]!;

  return { sourceTaskKey, targetTaskKey, relation_type: typeResult.data };
}

export const relationRouter = {
  delete: {
    run: (args) => {
      const props = parseRelationArgs(args);
      relation.delete(props);

      const source = task.getByKey(props.sourceTaskKey);
      const target = task.getByKey(props.targetTaskKey);
      console.info(`Deleted ${props.relation_type} relation from ${source.key} to ${target.key}`);
    },
    help: `Usage: zinn task relation delete <source-task-key> <target-task-key> --type <type>

Remove only the specified relation. No confirmation is required.

Types: related, dependency, duplicate.

For related, either task order works.
For dependency and duplicate, use the creation direction:
  source depends on target, or source is a duplicate of target.

Archived and cross-project tasks are supported.
A missing relation is an error.

Example: zinn task relation delete APP-1 APP-2 --type dependency`,
  },
  create: {
    run: (args) => {
      const props = parseRelationArgs(args);
      const { sourceTaskKey, targetTaskKey } = props;

      relation.create(props);

      const source = task.getByKey(sourceTaskKey);
      const target = task.getByKey(targetTaskKey);

      const label = {
        related: "related to",
        dependency: "depends on",
        duplicate: "is a duplicate of",
      }[props.relation_type];

      console.info(`${source.key} ${label} ${target.key}`);
    },
    help: `Usage: zinn task relation create <source-task-key> <target-task-key> --type <type>

Types:
  related     Connect two tasks, with any order provided to indicate relation.
  dependency  Source depends on target.
  duplicate   Source is a duplicate of target.

Relations do not have any side effects. They are purely for information.
Tasks from separate projects can be related to each other. Tasks can also be related to archived tasks.

Example: zinn task relation create APP-1 APP-2 --type dependency`,
  },
  list: {
    run: (args) => {
      const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
      validatePositionalCount(positionals, 1, "Provide exactly one task key");
      const output = formatRelations(positionals[0]!);

      if (output.length > 0) {
        console.info(output);
      }
    },
    help: `Usage: zinn task relation list <task-key>

Show incoming and outgoing relations with connected task keys and titles.
Archived connected tasks are included and marked Archived.
An empty list prints nothing.

Example: zinn task relation list APP-1`,
  },
} satisfies RouteDef;
