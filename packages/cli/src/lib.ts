import type { parseArgs } from "node:util";

import { assertWritable, ReadOnlyDatabaseError, UnmarkedDatabaseError } from "@zinn-dev/core";

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
export function confirmAction(message: string, isPreconfirmed: boolean) {
  // Throws on a read-only database, to avoid asking for confirmation to an already refused action
  assertWritable();

  return askConfirmation(message, isPreconfirmed);
}

/** Like confirmAction, without opening the database, for commands that bypass the open policy. */
export function askConfirmation(message: string, isPreconfirmed: boolean) {
  if (isPreconfirmed) {
    return true;
  }

  if (outputMode === "json") {
    quit("Commands that ask for confirmation need --yes when used with --json");
  }

  return confirm(message);
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

  if (error?.message === "no such table: task_search") {
    return `${error.message}. Run \`zinn reindex\` to rebuild the search index.`;
  }

  return error?.message ?? fallback;
}

export function quit(reason: string): never {
  if (outputMode === "json") {
    console.error(JSON.stringify({ error: { message: reason } }, null, 2));
  } else {
    console.error(reason);
  }

  process.exit(1);
}

export function validatePositionalCount(
  positionals: Array<string>,
  expected: number,
  message: string,
) {
  if (positionals.length !== expected) {
    quit(message);
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
