import type { parseArgs } from "node:util";

import {
  assertWritable,
  ReadOnlyDatabaseError,
  TextEditMatchError,
  UnmarkedDatabaseError,
} from "@zinn-dev/core";

type ParsedTokens = NonNullable<ReturnType<typeof parseArgs>["tokens"]>;
type OutputMode = "text" | "json";

let outputMode: OutputMode = "text";
let legacyReadAllowed = false;

export function setOutputMode(mode: OutputMode) {
  outputMode = mode;
}

export function isJsonFlag(flag: string) {
  return flag === "--json";
}

export function isAllowLegacyReadFlag(flag: string) {
  return flag === "--allow-legacy-read";
}

export function setLegacyReadAllowed(allowed: boolean) {
  legacyReadAllowed = allowed;
}

export function isLegacyReadAllowed() {
  return legacyReadAllowed;
}

export function output<T>(data: T, transformToString: (data: T) => string) {
  if (outputMode === "json") {
    console.info(JSON.stringify(data, null, 2));
    return;
  }

  const dataText = transformToString(data);

  if (dataText.length > 0) {
    console.info(dataText);
  }
}

/** Asks before a change that cannot be undone, unless --yes already confirmed it. */
export function confirmAction(message: string, isPreconfirmed: boolean, jsonRefusal?: string) {
  // Throws on a read-only database, to avoid asking for confirmation to an already refused action
  assertWritable();

  return askConfirmation(message, isPreconfirmed, jsonRefusal);
}

/** Like confirmAction, without opening the database, for commands that bypass the open policy. */
export function askConfirmation(
  message: string,
  isPreconfirmed: boolean,
  jsonRefusal = "Commands that ask for confirmation need --yes when used with --json",
) {
  if (isPreconfirmed) {
    return true;
  }

  if (outputMode === "json") {
    quit(jsonRefusal);
  }

  // Refuses rather than treating an unanswered prompt as declined, so scripts do not see a false success
  if (!canPrompt()) {
    quit("Commands that ask for confirmation need --yes when not running in a terminal");
  }

  return confirm(message);
}

/** Whether someone can answer a prompt: stdin and stdout are both terminals, like how gh decides it. */
export function canPrompt() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** The message to report for a failed command, or fallback when the error has none. */
export function failureMessage(error: any, fallback: string) {
  const isOlderReadOnly = error instanceof ReadOnlyDatabaseError && error.reason === "older";
  if (isOlderReadOnly) {
    return `${error.message}. Run \`zinn migrate\` to upgrade it.`;
  }

  if (error instanceof UnmarkedDatabaseError) {
    return `${error.message}. Add --allow-legacy-read to read it anyway.`;
  }

  if (error instanceof TextEditMatchError && error.matchCount > 1) {
    return `${error.message} Use --all to replace every match.`;
  }

  if (error?.message === "no such table: task_search") {
    return `${error.message}. Run \`zinn reindex\` to rebuild the search index.`;
  }

  return error?.message ?? fallback;
}

/** Prints the reason as an error, followed by help when given, and exits with code 1. */
export function quit(reason: string, help?: string): never {
  if (outputMode === "json") {
    const error = help == null ? { message: reason } : { message: reason, help };
    console.error(JSON.stringify({ error }, null, 2));
  } else {
    console.error(help == null ? reason : `${reason}\n\n${help}`);
  }

  process.exit(1);
}

/** A command was given the wrong words. The router prints the message with the command's usage lines. */
export class UsageError extends Error {}

/**
 * Checks a command's words against its usage line, with the words written the same way:
 * `<task-key>` is required, `[<project-key>]` is optional and `<task-key>...` repeats.
 * Optional words go last.
 */
export function validatePositionals(positionals: Array<string>, words: Array<string>) {
  const requiredWords = words.filter((word) => !word.startsWith("["));
  const missingWord = requiredWords[positionals.length];
  if (missingWord !== undefined) {
    throw new UsageError(`Missing argument ${missingWord}`);
  }

  const hasRepeatingWord = words.some((word) => word.endsWith("..."));
  const extraWord = positionals[words.length];
  if (!hasRepeatingWord && extraWord !== undefined) {
    throw new UsageError(`Unexpected argument "${extraWord}"`);
  }
}

export function validateUniqueOptions(tokens: ParsedTokens, repeatableOptions: Array<string> = []) {
  const parsedArgs = new Set<string>();

  for (const token of tokens) {
    if (token.kind !== "option") {
      continue;
    }

    const isRepeatable = repeatableOptions.includes(token.name);
    if (parsedArgs.has(token.name) && !isRepeatable) {
      quit(`Option "--${token.name}" can only be specified once`);
    }

    parsedArgs.add(token.name);
  }
}

export function isHelpFlag(flag: string) {
  return ["-h", "--help"].includes(flag);
}
