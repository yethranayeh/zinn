import type { ParseArgsOptionsConfig } from "node:util";
import type { ClassifiedFailure } from "./errors.js";
import type { ParsedRoute } from "./types.js";

import { closeSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isatty } from "node:tty";
import { parseArgs } from "node:util";
import {
  BYTES_PER_MEGABYTE,
  TELEMETRY_FOLDER_NAME,
  getConfiguredStorage,
  getProcessSettings,
  isMissingFileError,
  resolveTelemetry,
} from "@zinn-dev/core";

import packageJson from "../package.json" with { type: "json" };
import { detectAgent, readExecutionIdentity } from "./actor.js";
import { ensureFolderInStore } from "./failure-log.js";
import { helpSpellings, routerOptions } from "./input.js";
import { currentRuntime, readRunClock } from "./run-facts.js";

type RunOutcome = { failure?: ClassifiedFailure; logFileName?: string };
type ValueForm = "next" | "joined" | "none";
type UnmatchedRun = { namespace: string; unmatchedWord?: string; help: boolean };
type MatchedRun = {
  match: ParsedRoute;
  typedRoute: string;
  commandArgs: Array<string>;
  help: boolean;
};

const RECORD_VERSION = 1;
const RECORD_EXTENSION = ".jsonl";
const DOUBLE_DASH = "--";
const STDIN_DESCRIPTOR = 0;
const STDOUT_DESCRIPTOR = 1;
const ISO_DATE_LENGTH = "YYYY-MM-DD".length;
const DAY_FILE_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const RETENTION_DAYS = 90;
const MILLISECONDS_PER_DAY = 86_400_000;
/** A successful run of a command that declares one of these only reads or reports, and leaves no record */
const UNRECORDED_STORAGE_EFFECTS: ReadonlyArray<ParsedRoute["effects"]["storage"]> = [
  "none",
  "inspect",
];

let matchedRun: MatchedRun | null = null;
let unmatchedRun: UnmatchedRun | null = null;
let didParseArgsThrow = false;

export function noteMatchedRun(run: MatchedRun) {
  matchedRun = run;
  unmatchedRun = null;
  didParseArgsThrow = false;
}

/** An option-shaped word is left out of `unmatchedWord` because it can carry a value. `options` names it */
export function noteUnmatchedRun({ namespace, unmatchedWord, help }: UnmatchedRun) {
  matchedRun = null;
  didParseArgsThrow = false;
  unmatchedRun = {
    namespace,
    help,
    ...(unmatchedWord === undefined || unmatchedWord.startsWith("-") ? {} : { unmatchedWord }),
  };
}

export function noteParseArgsThrew() {
  didParseArgsThrow = true;
}

function readTokens(words: Array<string>, options: ParseArgsOptionsConfig) {
  return parseArgs({
    args: words,
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  }).tokens;
}

function readValueForm(
  token: { rawName: string; name: string; value?: string; inlineValue?: boolean },
  options: ParseArgsOptionsConfig,
): ValueForm | undefined {
  if (token.inlineValue === true) {
    return "joined";
  }

  if (helpSpellings.includes(token.rawName)) {
    return "none";
  }

  const type = Object.hasOwn(options, token.name) ? options[token.name]!.type : undefined;
  if (type === "boolean") {
    return "none";
  }

  return type === "string" && token.value !== undefined ? "next" : undefined;
}

/**
 * Every option written before `--`, by name.
 * A single-dash word such as `-later` counts once, under its first letter,
 *  since the letters after it may be a value.
 */
function describeOptions(words: Array<string>, known: ParseArgsOptionsConfig) {
  const separatorIndex = words.indexOf(DOUBLE_DASH);
  const optionWords = separatorIndex === -1 ? words : words.slice(0, separatorIndex);
  const options = { ...known, ...routerOptions };
  const describedWords = new Set<number>();
  const described: Array<{ name: string; valueForm?: ValueForm }> = [];

  for (const token of readTokens(optionWords, options)) {
    if (token.kind !== "option" || describedWords.has(token.index)) {
      continue;
    }

    describedWords.add(token.index);
    described.push({ name: token.rawName, valueForm: readValueForm(token, options) });
  }

  return described;
}

/** The facts the environment gives. Git is never read, so this spawns nothing */
function describeActor() {
  const agent = detectAgent(process.env);
  const identity = agent ?? readExecutionIdentity(process.env);

  return {
    kind: agent?.kind ?? "human",
    name: agent?.name ?? undefined,
    source: agent?.source,
    sessionId: identity.sessionId ?? undefined,
    threadId: identity.threadId ?? undefined,
    agent: identity.agent ?? undefined,
    model: identity.model ?? undefined,
    effort: identity.effort ?? undefined,
    client: identity.client,
  };
}

function describeCommand(words: Array<string>) {
  if (matchedRun !== null) {
    const { match, typedRoute, help } = matchedRun;

    return {
      route: match.command,
      alias: typedRoute === match.command ? undefined : typedRoute,
      help,
    };
  }

  // Root help prints without routing, and a failure to load the routes never reaches the router
  return (
    unmatchedRun ?? {
      namespace: "",
      help: words.some((word) => helpSpellings.includes(word)),
    }
  );
}

/** Left out with no route, for help and when parseArgs refused the words, because records never guess */
function countPositionals() {
  if (matchedRun === null || matchedRun.help || didParseArgsThrow) {
    return undefined;
  }

  const options = matchedRun.match.input.options as ParseArgsOptionsConfig;
  const tokens = readTokens(matchedRun.commandArgs, options);

  return tokens.filter((token) => token.kind === "positional").length;
}

function describeFailure({ failure, logFileName }: RunOutcome) {
  if (failure === undefined) {
    return undefined;
  }

  return {
    code: failure.code,
    reason: failure.details?.reason,
    argument: failure.details?.argument,
    suggestedRoute: failure.suggestedRoute?.join(" "),
    logFileName,
  };
}

function createRecord(outcome: RunOutcome, startedAt: Date, elapsedMs: number) {
  const words = process.argv.slice(2);
  const known =
    matchedRun === null ? {} : (matchedRun.match.input.options as ParseArgsOptionsConfig);

  return {
    v: RECORD_VERSION,
    startedAt: startedAt.toISOString(),
    durationMs: elapsedMs,
    exitCode: outcome.failure === undefined ? 0 : 1,
    actor: describeActor(),
    command: describeCommand(words),
    options: describeOptions(words, known),
    positionals: countPositionals(),
    error: describeFailure(outcome),
    version: packageJson.version,
    runtime: currentRuntime(),
    platform: process.platform,
    arch: process.arch,
    stdinIsTerminal: isatty(STDIN_DESCRIPTOR),
    stdoutIsTerminal: isatty(STDOUT_DESCRIPTOR),
    parentPid: process.ppid,
  };
}

function isUnrecordedRun({ failure }: RunOutcome) {
  return (
    failure === undefined &&
    matchedRun !== null &&
    !matchedRun.help &&
    UNRECORDED_STORAGE_EFFECTS.includes(matchedRun.match.effects.storage)
  );
}

/** One write on a descriptor opened for append, so parallel runs cannot split each other's lines */
function appendLine(path: string, line: string) {
  const descriptor = openSync(path, "a");

  try {
    writeSync(descriptor, line);
  } finally {
    closeSync(descriptor);
  }
}

/** A file's size in bytes or `undefined` when it does not exist */
function readFileSize(path: string) {
  try {
    return statSync(path).size;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

function firstLineOf(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

/**
 * Deletes expired day files, then the oldest others until the rest total under the cap.
 * A file another run already removed is not a failure. Any other failure throws and ends the cleanup.
 */
function deleteOldDayFiles(folder: string, startedAt: Date, capBytes: number) {
  const oldestKeptMs = startedAt.getTime() - RETENTION_DAYS * MILLISECONDS_PER_DAY;
  const oldestKeptDate = new Date(oldestKeptMs).toISOString().slice(0, ISO_DATE_LENGTH);
  const names = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && DAY_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const kept: Array<string> = [];

  for (const name of names) {
    const isExpired = name.slice(0, ISO_DATE_LENGTH) < oldestKeptDate;
    if (isExpired) {
      rmSync(join(folder, name), { force: true });
    } else {
      kept.push(name);
    }
  }

  const files = kept.map((name) => {
    const path = join(folder, name);
    return { path, size: readFileSize(path) ?? 0 };
  });
  let total = files.reduce((sum, { size }) => sum + size, 0);

  for (const { path, size } of files) {
    if (total < capBytes) {
      break;
    }

    rmSync(path, { force: true });
    total -= size;
  }
}

/**
 * Appends this run's record to the day's file in the store's `telemetry` folder.
 * A run that starts a new day file first deletes old ones. A day file at the size cap takes no more records.
 * It never throws, so recording cannot change a run's result.
 * Returns one sentence saying what went wrong, or `undefined` when nothing did or no record was due.
 */
export function writeRunRecord(outcome: RunOutcome) {
  try {
    if (isUnrecordedRun(outcome)) {
      return undefined;
    }

    const storage = getConfiguredStorage();
    const { mode, maxMegabytes } = resolveTelemetry(getProcessSettings(), process.env);
    if (mode !== "local") {
      return undefined;
    }

    const { startedAt, elapsedMs } = readRunClock();
    const folder = join(storage.directory, TELEMETRY_FOLDER_NAME);
    const name = `${startedAt.toISOString().slice(0, ISO_DATE_LENGTH)}${RECORD_EXTENSION}`;
    const path = join(folder, name);
    const line = `${JSON.stringify(createRecord(outcome, startedAt, elapsedMs))}\n`;
    const capBytes = maxMegabytes * BYTES_PER_MEGABYTE;

    ensureFolderInStore(folder);

    const daySize = readFileSize(path);
    if (daySize !== undefined && daySize >= capBytes) {
      return `dropped a record because ${path} has reached the ${maxMegabytes} MB cap`;
    }

    let cleanupProblem: string | undefined;
    if (daySize === undefined) {
      try {
        deleteOldDayFiles(folder, startedAt, capBytes);
      } catch (error) {
        cleanupProblem = `wrote the record but could not delete old day files: ${firstLineOf(error)}`;
      }
    }

    appendLine(path, line);

    return cleanupProblem;
  } catch (error) {
    return `could not write a record: ${firstLineOf(error)}`;
  }
}
