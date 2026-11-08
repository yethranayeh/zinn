/** Argument parsing for the Zinn release measurement tool. */

import { COMMAND_NAMES, selectCommands } from "./commands.ts";

/** A published release version, with an optional prerelease or build suffix. */
export const packageVersionPattern =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const DEFAULT_SIZES: readonly number[] = [100, 1_000, 10_000];
export const DEFAULT_RUNS = 30;
export const DEFAULT_WARMUP = 3;

export type TimeArguments = {
  kind: "time";
  version: string;
  sizes: number[];
  runs: number;
  warmup: number;
  /** Selected command names, in definition order. */
  commands: string[];
};

export type ParsedArguments =
  | TimeArguments
  | { kind: "disk"; version: string }
  | { kind: "error"; message: string };

export function parseArguments(args: readonly string[]): ParsedArguments {
  const mode = args[0];
  if (mode === undefined) {
    return { kind: "error", message: "pass a mode and a release version" };
  }
  if (mode !== "time" && mode !== "disk") {
    return { kind: "error", message: `unknown mode: ${mode}` };
  }
  const version = args[1];
  if (version === undefined) {
    return { kind: "error", message: `${mode} needs a release version` };
  }
  if (!packageVersionPattern.test(version)) {
    return { kind: "error", message: `Not a release version: ${version}` };
  }
  if (mode === "disk") {
    if (args.length > 2) {
      return { kind: "error", message: "disk takes only a release version" };
    }
    return { kind: "disk", version };
  }

  let sizes: number[] = [...DEFAULT_SIZES];
  let runs = DEFAULT_RUNS;
  let warmup = DEFAULT_WARMUP;
  let commands: string[] = [...COMMAND_NAMES];

  for (let index = 2; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--sizes" || argument.startsWith("--sizes=")) {
      const option = readOptionValue(argument, args, index);
      if (option.value === undefined) {
        return { kind: "error", message: "--sizes needs a comma-separated list of task counts" };
      }
      const parsed = parseSizes(option.value);
      if (parsed === undefined) {
        return {
          kind: "error",
          message: `--sizes needs positive whole task counts: ${option.value}`,
        };
      }
      sizes = parsed;
      index = option.index;
      continue;
    }
    if (argument === "--runs" || argument.startsWith("--runs=")) {
      const option = readOptionValue(argument, args, index);
      const parsed = parsePositiveInteger(option.value);
      if (parsed === undefined) {
        return { kind: "error", message: "--runs needs a positive whole number" };
      }
      runs = parsed;
      index = option.index;
      continue;
    }
    if (argument === "--warmup" || argument.startsWith("--warmup=")) {
      const option = readOptionValue(argument, args, index);
      const parsed = parseNonNegativeInteger(option.value);
      if (parsed === undefined) {
        return { kind: "error", message: "--warmup needs a whole number, zero or more" };
      }
      warmup = parsed;
      index = option.index;
      continue;
    }
    if (argument === "--commands" || argument.startsWith("--commands=")) {
      const option = readOptionValue(argument, args, index);
      const parsed = parseCommands(option.value);
      if (parsed === undefined) {
        return {
          kind: "error",
          message: `--commands needs a subset of ${COMMAND_NAMES.join(", ")}`,
        };
      }
      commands = parsed;
      index = option.index;
      continue;
    }
    return { kind: "error", message: `unknown option: ${argument}` };
  }

  return { kind: "time", version, sizes, runs, warmup, commands };
}

type OptionValue = { value: string | undefined; index: number };

function readOptionValue(argument: string, args: readonly string[], index: number): OptionValue {
  const separator = argument.indexOf("=");
  if (separator !== -1) {
    return { value: argument.slice(separator + 1), index };
  }
  const next = args[index + 1];
  if (next === undefined) {
    return { value: undefined, index };
  }
  return { value: next, index: index + 1 };
}

function parseSizes(text: string): number[] | undefined {
  const parts = text.split(",");
  if (text.length === 0 || parts.some((part) => part.length === 0)) {
    return undefined;
  }
  const sizes: number[] = [];
  for (const part of parts) {
    const value = parsePositiveInteger(part);
    if (value === undefined) {
      return undefined;
    }
    if (!sizes.includes(value)) {
      sizes.push(value);
    }
  }
  return sizes;
}

function parseCommands(text: string | undefined): string[] | undefined {
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  const parts = text.split(",");
  if (parts.some((part) => part.length === 0)) {
    return undefined;
  }
  for (const part of parts) {
    if (!COMMAND_NAMES.includes(part)) {
      return undefined;
    }
  }
  return selectCommands(parts).map((command) => command.name);
}

function parsePositiveInteger(text: string | undefined): number | undefined {
  const value = parseNonNegativeInteger(text);
  if (value === undefined || value === 0) {
    return undefined;
  }
  return value;
}

function parseNonNegativeInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^[0-9]+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return undefined;
  }
  return value;
}

export const USAGE = [
  "Usage:",
  "  bun run measure time <version> [--sizes 100,1000,10000] [--runs 30] [--warmup 3] [--commands list,view,...]",
  "  bun run measure disk <version>",
  "",
  "Commands:",
  `  ${COMMAND_NAMES.join(", ")}`,
].join("\n");
