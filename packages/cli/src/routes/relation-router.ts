import type { TaskRelationType, TaskWithKey } from "@zinn-dev/core";
import type { RouteDef } from "../types";

import { parseArgs } from "node:util";
import { column, relation, relationCreateSchema, task } from "@zinn-dev/core";
import { output, quit, validatePositionals, validateUniqueOptions } from "../lib";
import { currentActor } from "../actor";
import { formatCellSeparator, formatRows } from "../presentation/row-layout";
import { columnNameCell } from "../presentation/column-presentation";

type PresentedRelation = {
  type: TaskRelationType;
  direction: "outgoing" | "incoming" | null;
  task: { key: string; column: string; title: string; status: "Active" | "Archived" };
};

export function presentRelations(taskMatch: TaskWithKey): Array<PresentedRelation> {
  return relation.getAll(taskMatch.key, { include: { tasks: true } }).map((entry) => {
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
        column: column.getById(other.column_id)!.name,
        title: other.title,
        status: other.archived_at == null ? "Active" : "Archived",
      },
    };
  });
}

export function formatRelations(relations: Array<PresentedRelation>) {
  return formatRows(
    relations.map((entry) => {
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
        case "subtask": {
          label = isOutgoing ? "Parent" : "Subtask";
          break;
        }
        case "duplicate": {
          label = isOutgoing ? "Duplicate of" : "Duplicated by";
          break;
        }
      }

      const archived = entry.task.status === "Archived" ? `${formatCellSeparator()}Archived` : "";
      return [
        { text: label },
        { text: entry.task.key },
        columnNameCell(entry.task.column),
        { text: `${entry.task.title}${archived}` },
      ];
    }),
  );
}

type PresentedRelationChange = { type: TaskRelationType; source: string; target: string };

function parseRelationArgs(args: string[]) {
  const { values, positionals, tokens } = parseArgs({
    args,
    options: { type: { type: "string" } },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  validateUniqueOptions(tokens);
  validatePositionals(positionals, ["<source-task-key>", "<target-task-key>"]);

  const typeResult = relationCreateSchema.shape.relation_type.safeParse(values.type);

  if (!typeResult.success) {
    quit(
      `--type must be one of these: ${relationCreateSchema.shape.relation_type.options.join(", ")}`,
    );
  }
  const sourceTaskKey = positionals[0]!;
  const targetTaskKey = positionals[1]!;

  return { sourceTaskKey, targetTaskKey, relation_type: typeResult.data };
}

export const relationRouter = {
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
          subtask: "is a subtask of",
        }[r.type];

        return `${r.source} ${label} ${r.target}`;
      });
    },
    help: `Usage: zinn task relation create <source-task-key> <target-task-key> --type <type>

Types:
  related     Connect two tasks, with any order provided to indicate relation.
  dependency  Source depends on target.
  duplicate   Source is a duplicate of target.
  subtask     Source is a subtask of target (child -> parent).

A task may have one parent and many subtasks. Nesting is allowed; cycles are rejected.
Remove an existing subtask relation before assigning a different parent.

Relations do not automatically move, complete, or archive tasks.
Deleting a parent removes its links and preserves its subtasks.
Tasks from separate projects can be related to each other. Tasks can also be related to archived tasks.

Example: zinn task relation create APP-1 APP-2 --type dependency`,
  },
  list: {
    run: (args) => {
      const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
      validatePositionals(positionals, ["<task-key>"]);
      output(presentRelations(task.getByKey(positionals[0]!)), formatRelations);
    },
    help: `Usage: zinn task relation list <task-key>

Show incoming and outgoing relations with connected task keys, columns and titles.
Archived connected tasks are included and marked Archived.
An empty list prints nothing.

Example: zinn task relation list APP-1`,
  },
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

Types: ${relationCreateSchema.shape.relation_type.options.join(", ")}.

For related, either task order works.
For dependency, duplicate, and subtask, use the creation direction:
  source depends on target, is a duplicate of target, or is a subtask of target.

Archived and cross-project tasks are supported.
A missing relation is an error.

Example: zinn task relation delete APP-1 APP-2 --type dependency`,
  },
} satisfies RouteDef;
