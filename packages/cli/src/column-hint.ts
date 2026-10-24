import type { ParsedRoute } from "./types.js";
import type { InputOptions } from "./input.js";

import { parseArgs } from "node:util";
import { column, columnCreateSchema, parseTaskKey } from "@zinn-dev/core";

import { classifyFailure } from "./errors.js";
import { routerOptions, getOptionInputs, violatesConstraint } from "./input.js";
import {
  formatCommand,
  isAllowLegacyReadFlag,
  isRouterFlag,
  UsageError,
  validateUniqueOptions,
} from "./lib.js";
import { chooseProjectKey } from "./project.js";

type Word = { value: string; index: number };
type Merge = { start: number; end: number; value: string };
type Context = NonNullable<ReturnType<typeof column.inspect>>;
type ParsedToken = NonNullable<ReturnType<typeof parseArgs>["tokens"]>[number];
type OptionToken = Extract<ParsedToken, { kind: "option" }>;

function isEligible(error: unknown, command: string) {
  const failure = classifyFailure(error);
  const isExtraWord = error instanceof UsageError && failure.details?.field?.length === 0;
  const isMissingProject = failure.code === "not_found" && failure.details?.entity === "project";
  const isUsageErrorFor = (argument: string) =>
    error instanceof UsageError && failure.details?.argument === argument;

  switch (command) {
    case "project column create":
    case "project column edit":
      return isExtraWord;
    case "project column order":
      return isExtraWord || isUsageErrorFor("direction");
    case "task create":
    case "task list":
      return isExtraWord || isMissingProject || isUsageErrorFor("--all-projects");
    case "task move": {
      const isMissingEntity =
        failure.code === "not_found" &&
        ["column", "task", "project"].includes(failure.details?.entity ?? "");
      const isInvalidTaskKey =
        failure.code === "invalid_input" && failure.details?.field?.[0] === "taskKey";
      return isMissingEntity || isInvalidTaskKey;
    }
    default:
      return false;
  }
}

function joinWords(words: Word[]): Merge | undefined {
  const first = words[0];
  const isContiguous =
    first !== undefined && words.every((word, offset) => word.index === first.index + offset);

  if (!isContiguous || words.length < 2) {
    return undefined;
  }

  return {
    start: first.index,
    end: words.at(-1)!.index + 1,
    value: words.map((word) => word.value).join(" "),
  };
}

function hasColumn(context: Context, projectKey: string, name: string) {
  const parsedName = columnCreateSchema.shape.name.safeParse(name);
  if (!parsedName.success) {
    return false;
  }

  const project = context.projects.find((entry) => entry.key === projectKey.toUpperCase());
  if (project === undefined) {
    return false;
  }

  return project.columns.some(
    (columnName) => columnName.toLowerCase() === parsedName.data.toLowerCase(),
  );
}

function applyMerges(args: string[], merges: Merge[]) {
  const corrected = [...args];
  for (const merge of [...merges].sort((left, right) => right.start - left.start)) {
    corrected.splice(merge.start, merge.end - merge.start, merge.value);
  }
  return corrected;
}

/** Recognizes only checked split-column mistakes after an invocation has failed. */
export function quotedColumnHint(
  error: unknown,
  route: ParsedRoute,
  rawArgs: string[],
  routeWordCount: number,
): string | undefined {
  if (!isEligible(error, route.command)) {
    return undefined;
  }

  try {
    let argumentStart = 0;
    let wordsSeen = 0;
    for (const [index, word] of rawArgs.entries()) {
      if (!isRouterFlag(word)) {
        wordsSeen++;
      }
      if (wordsSeen === routeWordCount) {
        argumentStart = index + 1;
        break;
      }
    }
    const args = rawArgs.slice(argumentStart);
    const separatorIndex = rawArgs.indexOf("--");
    const optionArgs = separatorIndex === -1 ? rawArgs : rawArgs.slice(0, separatorIndex);
    const options: InputOptions = { ...route.input.options, ...routerOptions };
    const { tokens, values } = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });

    validateUniqueOptions(tokens, options);

    const optionInputs = getOptionInputs(values);
    const hasMissingOption = Object.entries(route.input.options).some(
      ([name, option]) => option.required && values[name] === undefined,
    );
    const hasInvalidChoice = Object.entries(route.input.options).some(([name, option]) => {
      const value = values[name];
      const comparableValue =
        typeof value === "string" && option.value?.caseInsensitive ? value.toLowerCase() : value;
      return (
        typeof comparableValue === "string" &&
        option.value?.choices !== undefined &&
        !option.value.choices.includes(comparableValue)
      );
    });
    const hasConflictingOptions = route.input.constraints.some((constraint) =>
      violatesConstraint(constraint, optionInputs),
    );
    const cannotSuggest = hasMissingOption || hasInvalidChoice || hasConflictingOptions;
    if (cannotSuggest) {
      return undefined;
    }
    const words: Word[] = tokens.flatMap((token) =>
      token.kind === "positional" ? [{ value: token.value, index: token.index }] : [],
    );
    const isMove = route.command === "task move";
    const isColumnOption = route.command === "task create" || route.command === "task list";
    const columnToken = tokens.find(
      (token): token is OptionToken => token.kind === "option" && token.name === "column",
    );

    const hasNoWords = words.length === 0;
    const hasTooFewMoveWords = isMove && words.length < 3;
    const hasNoColumnOption = isColumnOption && columnToken === undefined;
    if (hasNoWords || hasTooFewMoveWords || hasNoColumnOption) {
      return undefined;
    }

    const context = column.inspect({
      taskKeys: isMove ? words.map((word) => word.value) : [],
      allowsLegacyRead: optionArgs.some(isAllowLegacyReadFlag),
    });

    if (context === null) {
      return undefined;
    }

    const candidates = new Set<string>();
    const addCandidate = (merges: Merge[]) => {
      const corrected = [...rawArgs.slice(0, argumentStart), ...applyMerges(args, merges)];
      candidates.add(formatCommand(corrected));
    };

    if (isMove) {
      const targetWords = words.slice(-2);
      const merge = joinWords(targetWords);
      const existingKeys = new Set(context.taskKeys);
      const absorbsTask = targetWords.some((word) => existingKeys.has(word.value.toUpperCase()));
      const taskWords = words.slice(0, -2);
      const validTasks = taskWords.every((word) => existingKeys.has(word.value.toUpperCase()));
      const canSuggestMove =
        merge !== undefined &&
        !absorbsTask &&
        validTasks &&
        taskWords.every((word) =>
          hasColumn(context, parseTaskKey(word.value)!.projectKey, merge.value),
        );
      if (canSuggestMove) {
        addCandidate([merge]);
      }
    } else if (isColumnOption && typeof columnToken?.value === "string") {
      const columnValue = columnToken.value;
      const valueIndex = columnToken.inlineValue ? columnToken.index : columnToken.index + 1;
      const fragments = words.filter((word) => word.index > valueIndex);

      for (let count = 1; count <= fragments.length; count++) {
        const consumed = fragments.slice(0, count);
        const merge = joinWords([{ value: columnValue, index: valueIndex }, ...consumed]);
        const remaining = words.filter((word) => !consumed.includes(word));
        const discardsProject = consumed.some((word) =>
          context.projects.some((project) => project.key === word.value.toUpperCase()),
        );
        const conflictsWithAllProjects = values["all-projects"] === true && remaining.length > 0;

        if (merge === undefined) {
          continue;
        }

        const cannotSuggestSplit =
          remaining.length > 1 || discardsProject || conflictsWithAllProjects;
        if (cannotSuggestSplit) {
          continue;
        }

        const choice = chooseProjectKey(remaining[0]?.value, {
          required: route.command === "task create",
          allProjects: values["all-projects"] === true,
        });
        const matches =
          choice === undefined
            ? context.projects.some((project) => hasColumn(context, project.key, merge.value))
            : hasColumn(context, choice.key, merge.value);

        if (matches) {
          addCandidate([
            { ...merge, value: columnToken.inlineValue ? `--column=${merge.value}` : merge.value },
          ]);
        }
      }
    } else if (route.command === "project column order") {
      const projectKey = words[0]!.value;
      const directionPosition = route.input.forms[0]!.positionals.findIndex(
        (input) => input.name === "direction",
      );
      const originalDirection = words[directionPosition]?.value;
      const hasRecognizedDirection = route.input.forms.some((form) =>
        form.positionals[directionPosition]!.value.choices!.includes(originalDirection ?? ""),
      );

      for (
        let directionIndex = directionPosition;
        directionIndex < words.length;
        directionIndex++
      ) {
        const replacesRecognizedDirection =
          hasRecognizedDirection && directionIndex !== directionPosition;
        if (replacesRecognizedDirection) {
          continue;
        }

        const direction = words[directionIndex]!.value;
        const form = route.input.forms.find((candidate) =>
          candidate.positionals
            .find((input) => input.name === "direction")
            ?.value.choices?.includes(direction),
        );

        if (form === undefined) {
          continue;
        }

        const sourceWords = words.slice(1, directionIndex);
        const targetWords = words.slice(directionIndex + 1);
        const needsTarget = form.positionals.some((input) => input.name === "target-column-name");
        const hasTarget = targetWords.length > 0;
        const isUnexpectedTarget = !needsTarget && hasTarget;
        const isMissingTarget = needsTarget && !hasTarget;

        if (isUnexpectedTarget || isMissingTarget) {
          continue;
        }

        const source = sourceWords.map((word) => word.value).join(" ");
        const target = targetWords.map((word) => word.value).join(" ");
        const sourceMerge = joinWords(sourceWords);
        const targetMerge = joinWords(targetWords);
        const invalidSource = sourceWords.length > 1 && sourceMerge === undefined;
        const invalidTarget = targetWords.length > 1 && targetMerge === undefined;
        const merges = [sourceMerge, targetMerge].filter(
          (merge): merge is Merge => merge !== undefined,
        );
        const matchesSource = hasColumn(context, projectKey, source);
        const matchesTarget = !needsTarget || hasColumn(context, projectKey, target);
        const canSuggestOrder =
          !invalidSource && !invalidTarget && merges.length > 0 && matchesSource && matchesTarget;

        if (canSuggestOrder) {
          addCandidate(merges);
        }
      }
    } else {
      const merge = joinWords(words.slice(1));

      if (merge !== undefined && hasColumn(context, words[0]!.value, merge.value)) {
        addCandidate([merge]);
      }
    }
    return candidates.size === 1 ? [...candidates][0] : undefined;
  } catch {
    // A diagnostic lookup must not replace the original failure.
    return undefined;
  }
}
