import type { ParseArgsOptionsConfig } from "node:util";
import type { InputForm, InputOptions, InputOption } from "./input.js";
import type { ErrorCode, ErrorDetails } from "./errors.js";

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { assertWritable, InputValidationError } from "@zinn-dev/core";

import { CliError, classifyFailure, recoveryHint } from "./errors.js";
import { writeFailureLog } from "./failure-log.js";
import { helpSpellings, routerOptionNames, positionalWords } from "./input.js";
import { formatParserReasonPreview } from "./presentation/description-presentation.js";

type ParsedTokens = NonNullable<ReturnType<typeof parseArgs>["tokens"]>;
type OutputMode = "text" | "json";

let outputMode: OutputMode = "text";
let legacyReadAllowed = false;
const diagnostics: Array<string> = [];
/** Every notice of this run in order, kept for the failure log */
const runNotices: Array<string> = [];
/** Failures that write a log, because the error alone does not say what went wrong */
const LOGGED_ERROR_CODES: ReadonlyArray<ErrorCode> = ["storage", "internal"];
const DOUBLE_DASH = "--";
const MAX_PARSER_MESSAGE_LENGTH = 1024;

/** Keeps recovery guidance outside the shortened reason and never clips a repair command. */
export function boundParserMessage(
  message: string,
  options: { reason?: string; guidance?: string } = {},
) {
  if (message.length <= MAX_PARSER_MESSAGE_LENGTH) {
    return message;
  }

  const guidance = options.guidance ?? "See usage for accepted arguments.";
  const reason = formatParserReasonPreview(
    options.reason ?? message,
    MAX_PARSER_MESSAGE_LENGTH - guidance.length - 1,
  );

  return `${reason} ${guidance}`;
}

export function setOutputMode(mode: OutputMode) {
  outputMode = mode;
}

export function getOutputMode(): OutputMode {
  return outputMode;
}

/** Selects output before routing, without treating words after `--` as flags. */
export function prepareOutput(args: Array<string>) {
  const separatorIndex = args.indexOf(DOUBLE_DASH);
  const options = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  setOutputMode(options.some(isJsonFlag) ? "json" : "text");
}

/** Keeps JSON failures parseable while text-mode notices remain immediate. */
export function diagnostic(message: string) {
  runNotices.push(message);

  if (outputMode === "json") {
    diagnostics.push(message);
  } else {
    console.error(message);
  }
}

export function flushDiagnostics() {
  for (const message of diagnostics.splice(0)) {
    console.error(message);
  }
}

export function isJsonFlag(flag: string) {
  return flag === `--${routerOptionNames.json}`;
}

export function isAllowLegacyReadFlag(flag: string) {
  return flag === `--${routerOptionNames.legacyRead}`;
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

/** Includes change data in JSON and adds a stderr note for each unchanged object */
export function outputChanges<Change extends { changed: boolean }, Presented extends object>(
  changes: Array<Change>,
  present: (change: Change) => Presented,
  formatEntries: (entries: Array<Presented>) => string,
  describeUnchanged: (entry: Presented) => string,
) {
  const presentedChanges = changes.map((change) => ({
    ...present(change),
    changed: change.changed,
  }));

  if (presentedChanges.length === 1) {
    output(presentedChanges[0]!, (entry) => formatEntries([entry]));
  } else {
    output(presentedChanges, formatEntries);
  }

  for (const entry of presentedChanges) {
    if (!entry.changed) {
      diagnostic(describeUnchanged(entry));
    }
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

export const confirmationDescription =
  "Requires --yes with --json or without a terminal. Otherwise prompts on stderr and only y or Y confirms. Declining exits successfully without the requested mutation; interruption exits 130.";

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
    quit(jsonRefusal, undefined, { argument: "--yes", reason: "confirmation_required" });
  }

  // Refuses rather than treating an unanswered prompt as declined, so scripts do not see a false success
  if (!canPrompt()) {
    quit(
      "Commands that ask for confirmation need --yes when not running in a terminal",
      undefined,
      { argument: "--yes", reason: "confirmation_required" },
    );
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
  if (error instanceof z.ZodError) {
    return new InputValidationError(error.issues).message;
  }

  const hint = recoveryHint(error);
  if (hint !== undefined) {
    return `${error.message}${hint.suffix}`;
  }

  return typeof error?.message === "string" ? error.message : fallback;
}

/** Stops a command while retaining its classified error for the outer renderer. */
export function quit(reason: string | Error, help?: string, details?: ErrorDetails): never {
  if (reason instanceof Error) {
    throw reason;
  }

  throw new CliError(reason, "invalid_input", details, help);
}

/** Emits one handled failure, including any notices collected before it. */
export function renderFailure(reason: unknown): void {
  const classified = classifyFailure(reason);
  const failure = {
    code: classified.code,
    details: classified.details,
    help: classified.help,
    message: failureMessage(reason, "Something went wrong"),
  };
  const pendingDiagnostics = diagnostics.splice(0);
  const logPath = LOGGED_ERROR_CODES.includes(failure.code)
    ? writeFailureLog(reason, runNotices)
    : undefined;

  if (outputMode === "json") {
    const details = {
      ...Object.fromEntries(
        Object.entries(failure.details ?? {}).filter(([, value]) => value !== undefined),
      ),
      ...(logPath === undefined ? {} : { logPath }),
    };

    const error = {
      ...failure,
      details: Object.keys(details).length > 0 ? details : undefined,
      diagnostics: pendingDiagnostics.length > 0 ? pendingDiagnostics : undefined,
    };

    console.error(JSON.stringify({ error }, null, 2));
  } else {
    for (const message of pendingDiagnostics) {
      console.error(message);
    }

    console.error(failure.help == null ? failure.message : `${failure.message}\n\n${failure.help}`);

    if (logPath !== undefined) {
      console.error(`Full log: ${logPath}`);
    }
  }

  // Let piped stderr finish writing before Node exits
  process.stderr.write("", () => process.exit(1));
}

/** A command was given the wrong words. The router prints the message with the command's usage lines. */
export class UsageError extends CliError {
  constructor(message: string, details?: ErrorDetails) {
    super(boundParserMessage(message), "invalid_input", details);
  }
}

/**
 * Checks a command's words against its usage line, with the words written the same way:
 * `<task-key>` is required, `[<project-key>]` is optional and `<task-key>...` repeats.
 * Optional words go last.
 */
export function validatePositionals(positionals: Array<string>, form: InputForm) {
  const words = positionalWords(form);
  const requiredWords = words.filter((word) => !word.startsWith("["));
  const missingWord = requiredWords[positionals.length];

  if (missingWord !== undefined) {
    throw new UsageError(`Missing argument ${missingWord}`, {
      reason: "missing_argument",
      argument: missingWord.replaceAll(/[\[\]<>]/g, "").replace(/\.\.\.$/, ""),
    });
  }

  const hasRepeatingWord = words.some((word) => word.endsWith("..."));
  const extraWord = positionals[words.length];

  if (!hasRepeatingWord && extraWord !== undefined) {
    throw new UsageError(`Unexpected argument "${extraWord}"`, {
      field: [],
      reason: "unexpected_argument",
    });
  }
}

export function validateUniqueOptions(tokens: ParsedTokens, options: InputOptions) {
  const repeatableOptions = Object.keys(options).filter((name) => options[name]!.multiple);
  const parsedArgs = new Set<string>();

  for (const token of tokens) {
    if (token.kind !== "option") {
      continue;
    }

    const isRepeatable = repeatableOptions.includes(token.name);
    if (parsedArgs.has(token.name) && !isRepeatable) {
      quit(`Option "--${token.name}" can only be specified once`, undefined, {
        argument: `--${token.name}`,
      });
    }

    parsedArgs.add(token.name);
  }
}

/** The choices a positional accepts; positionals without choices contribute never. */
type PositionalChoices<Positional> = Positional extends {
  value: { choices: readonly (infer Choice)[] };
}
  ? Choice
  : never;

/** The direction words a form's direction positional accepts. */
type OrderDirection<Form extends InputForm> = PositionalChoices<
  Extract<Form["positionals"][number], { name: "direction" }>
>;

/**
 * A selected form with the direction word and the positional index it was read from.
 * Distributes over the form union, so each form keeps its own direction choices.
 */
type SelectedOrderForm<Form extends InputForm> = Form extends unknown
  ? Form & { direction: OrderDirection<Form>; directionIndex: number }
  : never;

/** Selects an order form after checking its required leading words. */
export function validateOrderForms<Form extends InputForm>(
  positionals: Array<string>,
  forms: readonly Form[],
): SelectedOrderForm<Form> {
  const firstForm = forms[0]!;
  const directionPosition = firstForm.positionals.findIndex(({ name }) => name === "direction");
  const leadingPositionals = firstForm.positionals.slice(0, directionPosition + 1);
  const directions = forms.flatMap((form) => form.positionals[directionPosition]!.value.choices!);
  const hasRepeatingSources = leadingPositionals.some((input) => input.max === null);
  const recognizedDirectionIndex = positionals.findIndex(
    (word, index) => index >= directionPosition && directions.includes(word),
  );
  const directionIndex =
    hasRepeatingSources && recognizedDirectionIndex !== -1
      ? recognizedDirectionIndex
      : directionPosition;

  leadingPositionals[directionPosition] = {
    ...leadingPositionals[directionPosition]!,
    value: { kind: "enum", choices: directions },
  };

  validatePositionals(positionals.slice(0, leadingPositionals.length), {
    id: "leading",
    positionals: leadingPositionals,
  });

  const direction = positionals[directionIndex]!;
  const form = forms.find((candidate) =>
    candidate.positionals[directionPosition]!.value.choices!.includes(direction),
  );

  if (form === undefined) {
    throw new UsageError(`Unknown order direction "${direction}"`, { argument: "direction" });
  }

  const sourceCount = directionIndex - directionPosition + 1;
  const expandedPositionals = form.positionals.flatMap((input) =>
    input.max === null
      ? Array.from({ length: sourceCount }, () => ({ ...input, max: 1 as const }))
      : [input],
  );
  validatePositionals(positionals, { ...form, positionals: expandedPositionals });

  // The direction is one of the matched form's choices, checked above.
  return { ...form, direction, directionIndex } as SelectedOrderForm<Form>;
}

export function requireStringOption(
  option: InputOption & { required: true },
  value: string | undefined,
  name: string,
  message: string,
): string {
  if (value === undefined) {
    quit(message, undefined, { argument: `--${name}`, reason: "missing_argument" });
  }

  return value;
}

export function isHelpFlag(flag: string) {
  return helpSpellings.includes(flag);
}

/**
 * Help sentence for a flag whose value may begin with a dash, such as a Markdown bullet.
 * `parseArgs` refuses `--flag -value`, since a value that looks like an option may mean the value
 *  was forgotten, so we respect that refusal and not take the next word as the value
 * @see {@link https://github.com/pkgjs/parseargs/issues/77}
 */
export function dashValueHelp(flag: string) {
  return `A value that begins with a dash must be joined to its flag with =, as in ${flag}='- item'.`;
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

  const reason = `Option "${flag}" is followed by "${value}", which begins with a dash.`;
  return boundParserMessage(
    `${reason} If it is the value, join it to the flag with =: ${fixedCommand}`,
    {
      reason,
      guidance:
        "Join the original value to its flag with =. Full command omitted because it is long.",
    },
  );
}

// "Unknown option '--project'."
const UNKNOWN_LONG_OPTION_PATTERN = /^Unknown option '(--[^']+)'/;
// A word that begins with a single dash, such as -later.
const SHORT_OPTION_WORD_PATTERN = /^-[^-]/;

/** A command line to show, with each word quoted for the shell as needed. */
export function formatCommand(args: Array<string>) {
  return ["zinn", ...args].map(shellQuote).join(" ");
}

/** The words of the command a user likely meant by a flag the command does not take, if known. */
type SuggestFor = (flag: string) => { args: Array<string>; route: Array<string> } | undefined;

/** Renames an option without changing values or words after `--` */
export function renameFlag(
  args: Array<string>,
  options: ParseArgsOptionsConfig,
  source: string,
  target: string,
) {
  const { tokens } = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const renamed = [...args];

  for (const token of tokens) {
    if (token.kind === "option" && token.name === source) {
      renamed[token.index] = `--${target}${token.inlineValue ? `=${token.value}` : ""}`;
    }
  }

  return renamed;
}

/**
 * The message for `parseArgs` refusal of an unknown option.
 * A long flag is named, with the command the user likely meant when one is known,
 *  and otherwise the usage line shown with it is the fix.
 * A word with a single dash shows the user's command with it after `--`.
 */
function unknownOptionMessage(
  message: string,
  args: Array<string>,
  suggestFor: SuggestFor,
  route: Array<string>,
): { message: string; suggestedRoute?: Array<string> } {
  const flag = UNKNOWN_LONG_OPTION_PATTERN.exec(message)?.[1];
  if (flag !== undefined) {
    const suggestion = suggestFor(flag);
    const reason = `Unknown option "${flag}"`;
    if (suggestion === undefined) {
      return { message: boundParserMessage(reason) };
    }

    const separatorIndex = suggestion.args.indexOf(DOUBLE_DASH);
    const optionEnd = separatorIndex === -1 ? suggestion.args.length : separatorIndex;
    const correctedArgs = [
      ...suggestion.args.slice(0, optionEnd),
      ...args.filter(isRouterFlag),
      ...suggestion.args.slice(optionEnd),
    ];
    return {
      message: boundParserMessage(`${reason}. Did you mean: ${formatCommand(correctedArgs)}`, {
        reason,
        guidance: "See usage for accepted arguments. Full command omitted because it is long.",
      }),
      suggestedRoute: suggestion.route,
    };
  }

  // Commands define no short options, so `parseArgs` refused the first single-dash word before `--`.
  const separatorIndex = args.indexOf(DOUBLE_DASH);
  const optionArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  const wordIndex = optionArgs.findIndex((arg) => SHORT_OPTION_WORD_PATTERN.test(arg));
  if (wordIndex === -1) {
    return { message: boundParserMessage(message) };
  }

  const word = args[wordIndex]!;
  const readOptions = [...word.slice(1)].map((letter) => `-${letter}`);
  const readAs = readOptions.length > 1 ? ` (Zinn read ${word} as ${readOptions.join(" ")})` : "";
  const reason = `Unknown option "${readOptions[0]}"${readAs}. If it is a value, put it after --`;
  const compactReason = `Unknown option in "${word}".`;
  const guidance =
    "If it is a value, put the original word after --. Full command omitted because it is long.";

  // Flags after the word must stay before --, and only the router's own flags are known to be flags.
  const wordsAfter = args.slice(wordIndex + 1);
  const routerFlagsAfter = wordsAfter.filter(isRouterFlag);
  const plainWordsAfter = wordsAfter.filter((arg) => !isRouterFlag(arg));
  if (plainWordsAfter.some((arg) => arg.startsWith("-"))) {
    return {
      message: boundParserMessage(`${reason}.`, {
        reason: compactReason,
        guidance: "If it is a value, put the original word after --.",
      }),
      suggestedRoute: route,
    };
  }

  const fixedCommand = formatCommand([
    ...args.slice(0, wordIndex),
    ...routerFlagsAfter,
    DOUBLE_DASH,
    word,
    ...plainWordsAfter,
  ]);

  return {
    message: boundParserMessage(`${reason}: ${fixedCommand}`, { reason: compactReason, guidance }),
    suggestedRoute: route,
  };
}

/**
 * An argument failure from parseArgs, rewritten where parseArgs' own advice misleads.
 * parseArgs names the flag only in its message text, which Node and Bun word the same.
 * `null` for any other error.
 */
export function parseArgsFailure(
  error: any,
  args: Array<string>,
  suggestFor: SuggestFor,
  route: Array<string>,
) {
  const code = error?.code;
  const isParseArgsError = typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
  if (!isParseArgsError) {
    return null;
  }

  const argument = /(?:Unknown option|Option) '(-[^' ]+)/.exec(error.message)?.[1];
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const hint = unknownOptionMessage(error.message, args, suggestFor, route);
    return new CliError(
      hint.message,
      "invalid_input",
      { argument, reason: "unknown_option" },
      undefined,
      hint.suggestedRoute,
    );
  }

  const dashMessage = dashValueMessage(error, args);
  const isMissingValue =
    code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && / argument missing$/.test(error.message);
  const reason =
    dashMessage !== null ? "dash_value" : isMissingValue ? "missing_argument" : undefined;

  return new CliError(
    dashMessage ?? boundParserMessage(error.message),
    "invalid_input",
    { argument, reason },
    undefined,
    dashMessage === null ? undefined : route,
  );
}
