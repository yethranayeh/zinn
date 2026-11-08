/** Job descriptions from a JSON file or from the command after `--`. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { commandLine } from "./format.ts";

export type JobSpec = {
  name: string;
  /** The command text shown in the plan and log. */
  command: string;
  estimateMinutes?: number;
  /** Present for the `--` form, where each argument is already a separate word. */
  argv?: string[];
};

export function readJobsFile(path: string, cwd: string): JobSpec[] {
  const absolutePath = resolve(cwd, path);
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read jobs file ${absolutePath}: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`jobs file ${absolutePath} must contain a JSON array`);
  }

  return parsed.map((entry, index) => readJob(entry, index, absolutePath));
}

function readJob(value: unknown, index: number, path: string): JobSpec {
  const position = `job ${index + 1} in ${path}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${position} is not an object`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    throw new Error(`${position} needs a name`);
  }

  if (typeof record.command !== "string" || record.command.trim().length === 0) {
    throw new Error(`${position} needs a command`);
  }

  if (record.estimateMinutes !== undefined) {
    if (
      typeof record.estimateMinutes !== "number" ||
      !Number.isFinite(record.estimateMinutes) ||
      record.estimateMinutes < 0
    ) {
      throw new Error(`${position} has an invalid estimateMinutes`);
    }
  }

  return {
    name: record.name,
    command: record.command,
    estimateMinutes: record.estimateMinutes,
  };
}

/** One job from `-- <command...>`, named after the command's first word. */
export function commandJob(command: readonly string[]): JobSpec {
  const firstWord = command[0];
  if (firstWord === undefined || firstWord.length === 0) {
    throw new Error("the command after -- is empty");
  }

  return {
    name: firstWord,
    command: commandLine(command),
    argv: [...command],
  };
}
