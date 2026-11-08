/** Command-line parsing for one session run or the restore command. */

import type { SettingFlags } from "./settings.ts";

export type ParsedSession = {
  kind: "session";
  settings: SettingFlags;
  stopOnFailure: boolean;
  dryRun: boolean;
  outDir?: string;
  jobsPath?: string;
  sampleSeconds?: number;
  command?: string[];
};

export type ParsedArguments =
  | ParsedSession
  | { kind: "restore" }
  | { kind: "error"; message: string };

export function parseArguments(args: readonly string[]): ParsedArguments {
  if (args.length === 1 && args[0] === "restore") {
    return { kind: "restore" };
  }

  const settings: SettingFlags = { spotlight: false, timeMachine: false, wifi: false };
  let stopOnFailure = false;
  let dryRun = false;
  let outDir: string | undefined;
  let jobsPath: string | undefined;
  let sampleSeconds: number | undefined;
  let command: string[] | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") {
      command = args.slice(index + 1);
      break;
    }
    if (argument === "--spotlight-off") {
      settings.spotlight = true;
      continue;
    }
    if (argument === "--time-machine-off") {
      settings.timeMachine = true;
      continue;
    }
    if (argument === "--wifi-off") {
      settings.wifi = true;
      continue;
    }
    if (argument === "--stop-on-failure") {
      stopOnFailure = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--out" || argument.startsWith("--out=")) {
      const value = readOptionValue(argument, args, index);
      if (value.value === undefined || value.value.length === 0) {
        return { kind: "error", message: "--out needs a directory" };
      }
      outDir = value.value;
      index = value.index;
      continue;
    }
    if (argument === "--jobs" || argument.startsWith("--jobs=")) {
      const value = readOptionValue(argument, args, index);
      if (value.value === undefined || value.value.length === 0) {
        return { kind: "error", message: "--jobs needs a file" };
      }
      jobsPath = value.value;
      index = value.index;
      continue;
    }
    if (argument === "--sample-seconds" || argument.startsWith("--sample-seconds=")) {
      const value = readOptionValue(argument, args, index);
      const seconds = Number(value.value);
      if (value.value === undefined || !Number.isInteger(seconds) || seconds < 1) {
        return {
          kind: "error",
          message: "--sample-seconds needs a whole number of seconds, 1 or more",
        };
      }
      sampleSeconds = seconds;
      index = value.index;
      continue;
    }
    if (argument === "restore") {
      return { kind: "error", message: "restore takes no other arguments" };
    }
    if (argument.startsWith("-")) {
      return { kind: "error", message: `unknown option: ${argument}` };
    }
    command = args.slice(index);
    break;
  }

  if (command !== undefined && command.length === 0) {
    return { kind: "error", message: "the command after -- is empty" };
  }
  if (jobsPath !== undefined && command !== undefined) {
    return { kind: "error", message: "--jobs and -- cannot be used together" };
  }
  if (jobsPath === undefined && command === undefined) {
    return { kind: "error", message: "pass --jobs <jobs.json> or -- <command...>" };
  }

  return {
    kind: "session",
    settings,
    stopOnFailure,
    dryRun,
    outDir,
    jobsPath,
    sampleSeconds,
    command,
  };
}

type OptionValue = { value: string; index: number } | { value: undefined; index: number };

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

export const USAGE = [
  "Usage:",
  "  bun run measure:quiet [flags] --jobs <jobs.json>",
  "  bun run measure:quiet [flags] -- <command...>",
  "  bun run measure:quiet restore",
  "",
  "Flags:",
  "  --spotlight-off     turn Spotlight indexing off for the session",
  "  --time-machine-off  turn automatic Time Machine backups off for the session",
  "  --wifi-off          turn the Wi-Fi interface off for the session",
  "  --stop-on-failure   stop after the first failed job",
  "  --dry-run           print the plan without changing anything",
  "  --out <dir>         session output directory (default .measure)",
  "  --sample-seconds <n>  seconds between load and process samples (default 5)",
].join("\n");
