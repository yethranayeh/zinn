import type { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";

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

/** A flag the router reads wherever it appears before --, for every command. */
export function isRouterFlag(flag: string) {
  return isJsonFlag(flag) || isAllowLegacyReadFlag(flag);
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
export async function confirmAction(
  message: string,
  isPreconfirmed: boolean,
  jsonRefusal?: string,
) {
  // Throws on a read-only database, to avoid asking for confirmation to an already refused action
  assertWritable();

  return askConfirmation(message, isPreconfirmed, jsonRefusal);
}

/** Like confirmAction, without opening the database, for commands that bypass the open policy. */
export async function askConfirmation(
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

  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const closed = new AbortController();
  prompt.once("close", () => closed.abort());
  prompt.once("SIGINT", () => process.kill(process.pid, "SIGINT"));

  try {
    const answer = await prompt.question(`${message} [y/N] `, { signal: closed.signal });
    return answer === "y" || answer === "Y";
  } catch (error) {
    if (closed.signal.aborted) {
      return false;
    }
    throw error;
  } finally {
    // Readline echoes a newline in a terminal; redirected stderr and EOF need one explicitly.
    if (!process.stderr.isTTY || closed.signal.aborted) {
      process.stderr.write("\n");
    }
    prompt.close();
  }
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

/**
 * Help sentence for a flag whose value may begin with a dash, such as a Markdown bullet.
 * `parseArgs` refuses `--flag -value`, since a value that looks like an option may mean the value
 *  was forgotten, so we respect that refusal and not take the next word as the value
 * @see {@link https://github.com/pkgjs/parseargs/issues/77}
 */
export function dashValueHelp(flag: string) {
  return `A value that begins with a dash must be joined to its flag with =, as in ${flag}="- item".`;
}

// "Option '--title' argument is ambiguous."
const DASH_VALUE_ERROR_PATTERN = /^Option '(--[^']+)' argument is ambiguous\./;
// The characters Python's `shlex.quote` leaves unquoted.
const SHELL_SAFE_WORD_PATTERN = /^[\w@%+=:,./-]+$/;

/** Quotes a word for a POSIX shell when it needs it, like Python's `shlex.quote` */
export function shellQuote(word: string) {
  if (SHELL_SAFE_WORD_PATTERN.test(word)) {
    return word;
  }

  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The message for `parseArgs` refusal of a value that begins with a dash, showing the user's
 *  command with that value joined to its flag.
 * `null` for any other error
 */
function dashValueMessage(error: any, args: Array<string>) {
  const isInvalidOptionValue = error?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
  const flag = isInvalidOptionValue ? DASH_VALUE_ERROR_PATTERN.exec(error.message)?.[1] : undefined;
  const flagIndex = args.findIndex(
    (arg, index) => arg === flag && args[index + 1]?.startsWith("-"),
  );

  if (flagIndex === -1) {
    return null;
  }

  const value = args[flagIndex + 1]!;
  const fixedCommand = [
    "zinn",
    ...args.slice(0, flagIndex).map(shellQuote),
    `${flag}=${shellQuote(value)}`,
    ...args.slice(flagIndex + 2).map(shellQuote),
  ].join(" ");

  return `Option "${flag}" is followed by "${value}", which begins with a dash. If it is the value, join it to the flag with =: ${fixedCommand}`;
}

// "Unknown option '--project'."
const UNKNOWN_LONG_OPTION_PATTERN = /^Unknown option '(--[^']+)'/;
// A word that begins with a single dash, such as -later.
const SHORT_OPTION_WORD_PATTERN = /^-[^-]/;

/** A command line to show, with each word quoted for the shell as needed. */
function formatCommand(args: Array<string>) {
  return ["zinn", ...args].map(shellQuote).join(" ");
}

/** The words of the command a user likely meant by a flag the command does not take, if known. */
type SuggestFor = (flag: string) => Array<string> | undefined;

/**
 * The message for `parseArgs` refusal of an unknown option.
 * A long flag is named, with the command the user likely meant when one is known,
 *  and otherwise the usage line shown with it is the fix.
 * A word with a single dash shows the user's command with it after `--`.
 */
function unknownOptionMessage(message: string, args: Array<string>, suggestFor: SuggestFor) {
  const DOUBLE_DASH = "--";
  const flag = UNKNOWN_LONG_OPTION_PATTERN.exec(message)?.[1];
  if (flag !== undefined) {
    const suggestion = suggestFor(flag);
    const reason = `Unknown option "${flag}"`;
    return suggestion === undefined
      ? reason
      : `${reason}. Did you mean: ${formatCommand([...suggestion, ...args.filter(isRouterFlag)])}`;
  }

  // Commands define no short options, so `parseArgs` refused the first single-dash word before `--`.
  const separatorIndex = args.indexOf(DOUBLE_DASH);
  const optionArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  const wordIndex = optionArgs.findIndex((arg) => SHORT_OPTION_WORD_PATTERN.test(arg));
  if (wordIndex === -1) {
    return message;
  }

  const word = args[wordIndex]!;
  const readOptions = [...word.slice(1)].map((letter) => `-${letter}`);
  const readAs = readOptions.length > 1 ? ` (Zinn read ${word} as ${readOptions.join(" ")})` : "";
  const reason = `Unknown option "${readOptions[0]}"${readAs}. If it is a value, put it after --`;

  // Flags after the word must stay before --, and only the router's own flags are known to be flags.
  const wordsAfter = args.slice(wordIndex + 1);
  const routerFlagsAfter = wordsAfter.filter(isRouterFlag);
  const plainWordsAfter = wordsAfter.filter((arg) => !isRouterFlag(arg));
  if (plainWordsAfter.some((arg) => arg.startsWith("-"))) {
    return `${reason}.`;
  }

  const fixedCommand = formatCommand([
    ...args.slice(0, wordIndex),
    ...routerFlagsAfter,
    DOUBLE_DASH,
    word,
    ...plainWordsAfter,
  ]);

  return `${reason}: ${fixedCommand}`;
}

/**
 * The message for an argument error from parseArgs, rewritten where parseArgs' own advice misleads.
 * parseArgs names the flag only in its message text, which Node and Bun word the same.
 * `null` for any other error.
 */
export function parseArgsMessage(error: any, args: Array<string>, suggestFor: SuggestFor) {
  const code = error?.code;
  const isParseArgsError = typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
  if (!isParseArgsError) {
    return null;
  }

  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    return unknownOptionMessage(error.message, args, suggestFor);
  }

  return dashValueMessage(error, args) ?? error.message;
}
