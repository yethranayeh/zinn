import type { RelationCreateInput } from "@zinn-dev/core";
import type { RouteDef } from "../types";

import { parseArgs } from "node:util";
import { relation, relationCreateSchema, task } from "@zinn-dev/core";
import { output, quit, validatePositionalCount, validateUniqueOptions } from "../lib";
import { currentActor } from "../actor";

// TODO: maybe core should export it as a reusable if we need it in more places
type RelationType = RelationCreateInput["relation_type"];

type PresentedRelation = {
  type: RelationType;
  direction: "outgoing" | "incoming" | null;
  task: { key: string; title: string; status: "Active" | "Archived" };
};

export function presentRelations(taskKey: string): Array<PresentedRelation> {
  const taskMatch = task.getByKey(taskKey);

  return relation.getAll(taskKey, { include: { tasks: true } }).map((entry) => {
    const isSource = entry.source_task_id === taskMatch.id;
    const other = isSource ? entry.target : entry.source;
    if (other == null) {
      throw new Error("Connected task details were not included in the relation");
    }

    let direction: PresentedRelation["direction"] = null;
    if (entry.relation_type !== "related") {
      direction = isSource ? "outgoing" : "incoming";
    }

    return {
      type: entry.relation_type,
      direction,
      task: {
        key: other.key,
        title: other.title,
        status: other.archived_at == null ? "Active" : "Archived",
      },
    };
  });
}

export function formatRelations(relations: Array<PresentedRelation>) {
  return relations
    .map((entry) => {
      const isOutgoing = entry.direction === "outgoing";

      let label: string;
      switch (entry.type) {
        case "related": {
          label = "Related to";
          break;
        }
        case "dependency": {
          label = isOutgoing ? "Depends on" : "Depended on by";
          break;
        }
        case "duplicate": {
          label = isOutgoing ? "Duplicate of" : "Duplicated by";
          break;
        }
      }

      const archived = entry.task.status === "Archived" ? " | Archived" : "";
      return `${label} | ${entry.task.key} | ${entry.task.title}${archived}`;
    })
    .join("\n");
}

type PresentedRelationChange = { type: RelationType; source: string; target: string };

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
      relation.delete(props, currentActor());

      const source = task.getByKey(props.sourceTaskKey);
      const target = task.getByKey(props.targetTaskKey);
      const deleted: PresentedRelationChange = {
        type: props.relation_type,
        source: source.key,
        target: target.key,
      };

      output(deleted, (r) => `Deleted ${r.type} relation from ${r.source} to ${r.target}`);
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

      relation.create(props, currentActor());

      const source = task.getByKey(sourceTaskKey);
      const target = task.getByKey(targetTaskKey);
      const created: PresentedRelationChange = {
        type: props.relation_type,
        source: source.key,
        target: target.key,
      };

      output(created, (r) => {
        const label = {
          related: "related to",
          dependency: "depends on",
          duplicate: "is a duplicate of",
        }[r.type];

        return `${r.source} ${label} ${r.target}`;
      });
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
      output(presentRelations(positionals[0]!), formatRelations);
    },
    help: `Usage: zinn task relation list <task-key>

Show incoming and outgoing relations with connected task keys and titles.
Archived connected tasks are included and marked Archived.
An empty list prints nothing.

Example: zinn task relation list APP-1`,
  },
} satisfies RouteDef;
