import type { TaskRelationType } from "@zinn-dev/core";
import type { CommandInput } from "../input.js";
import type { RouteDef } from "../types.js";

import { parseArgs } from "node:util";
import { relation, relationTypeSchema, task } from "@zinn-dev/core";

import { jsonResult } from "../results.js";
import { generateCommandUsage, taskKeyPositional } from "../input.js";
import {
  output,
  diagnostic,
  confirmAction,
  confirmationDescription,
  quit,
  requireStringOption,
  validatePositionals,
  validateUniqueOptions,
} from "../lib.js";
import { currentActor } from "../actor.js";
import {
  formatRelationChange,
  formatRelationList,
  presentRelations,
  presentRelationChange,
} from "../presentation/relation-presentation.js";

const guessedRelationTypes = new Map<string, TaskRelationType>([
  ["depends-on", "dependency"],
  ["parent", "subtask"],
  ["duplicate-of", "duplicate"],
  ["related", "related"],
]);

function relationFlagSuggestions(action: "create" | "delete") {
  const options = {
    ...relationInputs[action].options,
    ...Object.fromEntries(
      [...guessedRelationTypes.keys()].map((name) => [name, { type: "string" as const }]),
    ),
  };

  const suggest = (args: Array<string>) => {
    const { positionals, tokens } = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
    const relationFlags = tokens.filter(
      (token) => token.kind === "option" && guessedRelationTypes.has(token.name),
    );
    const guessed = relationFlags[0];

    if (positionals.length !== 1 || relationFlags.length !== 1 || guessed?.kind !== "option") {
      return undefined;
    }

    const type = guessedRelationTypes.get(guessed.name)!;
    const typeFlags = tokens.filter((token) => token.kind === "option" && token.name === "type");
    const hasConflictingType = typeFlags.some(
      (token) => token.kind === "option" && token.value !== type,
    );
    const hasOtherOption = tokens.some(
      (token) =>
        token.kind === "option" && token.name !== "type" && !guessedRelationTypes.has(token.name),
    );

    const cannotSuggestRelation =
      typeof guessed.value !== "string" ||
      typeFlags.length > 1 ||
      hasConflictingType ||
      hasOtherOption;

    if (cannotSuggestRelation) {
      return undefined;
    }

    return ["task", "relation", action, positionals[0]!, guessed.value, "--type", type];
  };

  return Object.fromEntries([...guessedRelationTypes.keys()].map((name) => [`--${name}`, suggest]));
}

function parseRelationArgs(args: string[], action: "create" | "delete") {
  const input = relationInputs[action];
  const { values, positionals, tokens } = parseArgs({
    args,
    options: input.options,
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  validateUniqueOptions(tokens, input.options);
  validatePositionals(positionals, input.forms[0]);

  const type = requireStringOption(
    relationPairInput.options.type,
    values.type,
    "type",
    `--type must be one of these: ${relationPairInput.options.type.value.choices.join(", ")}`,
  );
  const typeResult = relationTypeSchema.safeParse(type);

  if (!typeResult.success) {
    quit(`--type must be one of these: ${relationTypeSchema.options.join(", ")}`, undefined, {
      argument: "--type",
    });
  }
  const sourceTaskKey = positionals[0]!;
  const targetTaskKey = positionals[1]!;

  return {
    props: { sourceTaskKey, targetTaskKey, relation_type: typeResult.data },
    isPreconfirmed: "yes" in values && values.yes === true,
  };
}

const relationPairInput = {
  options: {
    type: {
      type: "string",
      required: true,
      value: {
        kind: "enum",
        choices: relationTypeSchema.options,
      },
    },
  },
  forms: [
    {
      id: "default",
      positionals: [
        { ...taskKeyPositional, name: "source-task-key" },
        { ...taskKeyPositional, name: "target-task-key" },
      ],
    },
  ],
  constraints: [],
} as const satisfies CommandInput;

const relationInputs = {
  create: {
    ...relationPairInput,
    options: { ...relationPairInput.options, yes: { type: "boolean" } },
  },
  delete: relationPairInput,
  list: {
    options: {},
    forms: [
      {
        id: "default",
        positionals: [taskKeyPositional],
      },
    ],
    constraints: [],
  },
} as const satisfies Record<string, CommandInput>;

export const relationRouter = {
  create: {
    summary: "Create a relation, confirming replacement of conflicting links.",
    effects: { domain: "replace", storage: "normal-open" },
    confirmation: {
      kind: "prompt",
      description: `Only asks when replacing existing relations. ${confirmationDescription}`,
    },
    input: relationInputs.create,
    results: [jsonResult("RelationChange")],
    guessedFlags: relationFlagSuggestions("create"),
    run: async (args) => {
      const { props, isPreconfirmed } = parseRelationArgs(args, "create");
      const { sourceTaskKey, targetTaskKey } = props;
      const source = task.getByKey(sourceTaskKey);
      const target = task.getByKey(targetTaskKey);
      let replace: boolean | Array<string> = isPreconfirmed;

      if (!isPreconfirmed) {
        const conflicts = relation.getConflicts(props);
        if (conflicts.length > 0) {
          const canReplace = await confirmAction(
            formatRelationChange(
              { type: props.relation_type, source: source.key, target: target.key },
              {
                action: "replace",
                replaced: conflicts.map((entry) =>
                  presentRelationChange(entry, entry.source, entry.target),
                ),
              },
            ),
            false,
          );

          if (!canReplace) {
            diagnostic("Relation creation cancelled");
            return;
          }

          replace = conflicts.map((entry) => entry.id);
        }
      }

      const createdRelation = relation.create({ ...props, replace }, currentActor());
      const created = presentRelationChange(createdRelation, source, target);

      output(created, (entry) => formatRelationChange(entry, { action: "create" }));
    },
    help: `${generateCommandUsage("task relation create", relationInputs.create)}

Create a relation between two tasks.
Each pair may have one relation. Changing its type or direction asks to replace the existing links.
Use --yes to authorize replacement without a prompt, including with --json or without a terminal.
An exact existing relation is an error, including with --yes.

Types:
  related     Connect two tasks, with any order provided to indicate relation.
  dependency  Source depends on target.
  duplicate   Source is a duplicate of target.
  subtask     Source is a subtask of target (child -> parent).

A task may have one parent and many subtasks. Nesting is allowed. Cycles are rejected.
Assigning a different parent asks to replace the previous parent link and any conflicting link to the new parent.
One confirmation covers every removed link. If those links change while confirmation is open, the command fails.

Relations do not automatically move, complete, or archive tasks.
Deleting a parent removes its links and preserves its subtasks.
Tasks from separate projects can be related to each other. Tasks can also be related to archived tasks.

Example: zinn task relation create APP-1 APP-2 --type dependency`,
  },
  list: {
    summary: "Show incoming and outgoing relations with connected task keys, columns and titles.",
    effects: { domain: "read", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: relationInputs.list,
    results: [jsonResult("RelationList")],
    run: (args) => {
      const { positionals } = parseArgs({
        options: relationInputs.list.options,
        args,
        allowPositionals: true,
        strict: true,
      });
      validatePositionals(positionals, relationInputs.list.forms[0]);
      output(presentRelations(task.getByKey(positionals[0]!)), formatRelationList);
    },
    help: `${generateCommandUsage("task relation list", relationInputs.list)}

Show incoming and outgoing relations with connected task keys, columns and titles.
Archived connected tasks are included and marked Archived.
An empty list prints nothing.

Example: zinn task relation list APP-1`,
  },
  delete: {
    summary: "Remove only the specified relation. No confirmation is required.",
    effects: { domain: "delete", storage: "normal-open" },
    confirmation: { kind: "none" },
    input: relationInputs.delete,
    results: [jsonResult("RelationChange")],
    guessedFlags: relationFlagSuggestions("delete"),
    run: (args) => {
      const { props } = parseRelationArgs(args, "delete");
      const deletedRelation = relation.delete(props, currentActor());

      const source = task.getByKey(props.sourceTaskKey);
      const target = task.getByKey(props.targetTaskKey);
      const deleted = presentRelationChange(deletedRelation, source, target);

      output(deleted, (entry) => formatRelationChange(entry, { action: "delete" }));
    },
    help: `${generateCommandUsage("task relation delete", relationInputs.delete)}

Remove only the specified relation. No confirmation is required.

Types: ${relationTypeSchema.options.join(", ")}.

For related, either task order works.
For dependency, duplicate, and subtask, use the creation direction:
  source depends on target, is a duplicate of target, or is a subtask of target.

Archived and cross-project tasks are supported.
A missing relation is an error.

Example: zinn task relation delete APP-1 APP-2 --type dependency`,
  },
} satisfies RouteDef;
