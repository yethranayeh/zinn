#!/usr/bin/env bun
/** Entry point for a quiet measurement session. */
import type { JobSpec } from "./jobs.ts";
import type { SessionSignal, SignalSource } from "./session.ts";

import { resolve } from "node:path";

import { parseArguments, USAGE } from "./args.ts";
import { commandJob, readJobsFile } from "./jobs.ts";
import { createRunner } from "./runner.ts";
import { runRestoreCommand } from "./restore.ts";
import { runSession, sessionFolderId } from "./session.ts";
import { resolveStatePath } from "./state.ts";

// A write to a closed terminal raises an error event. The session log keeps every line
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const USAGE_ERROR_EXIT = 2;
const SIGNALS: SessionSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
    return USAGE_ERROR_EXIT;
  }

  if (process.getuid?.() === 0) {
    process.stderr.write("quiet-session refuses to run as root. Run it as your own user.\n");
    return USAGE_ERROR_EXIT;
  }

  const runner = createRunner();
  const write = (text: string) => {
    process.stdout.write(text);
  };
  const statePath = resolveStatePath();

  if (parsed.kind === "restore") {
    try {
      return await runRestoreCommand({ runner, statePath, write });
    } catch (error) {
      process.stderr.write(`Restore failed: ${errorMessage(error)}\n`);
      return 1;
    }
  }

  const cwd = process.cwd();
  const outDir = resolve(cwd, parsed.outDir ?? ".measure");
  let jobs: JobSpec[];
  try {
    jobs =
      parsed.jobsPath !== undefined
        ? readJobsFile(parsed.jobsPath, cwd)
        : [commandJob(parsed.command ?? [])];
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return USAGE_ERROR_EXIT;
  }

  const startedAt = new Date();
  const sessionId = sessionFolderId(outDir, startedAt);
  try {
    const outcome = await runSession({
      runner,
      settings: parsed.settings,
      jobs,
      stopOnFailure: parsed.stopOnFailure,
      dryRun: parsed.dryRun,
      outDir,
      cwd,
      statePath,
      sessionId,
      startedAt,
      signalSource: createSignalSource(),
      sampleSeconds: parsed.sampleSeconds,
      write,
    });
    return outcome.exitCode;
  } catch (error) {
    process.stderr.write(`quiet-session failed: ${errorMessage(error)}\n`);
    return 1;
  }
}

function createSignalSource(): SignalSource {
  return {
    on(handler) {
      const registrations = SIGNALS.map((signal) => {
        const listener = () => {
          handler(signal);
        };
        process.on(signal, listener);
        return { signal, listener };
      });
      return () => {
        for (const registration of registrations) {
          process.off(registration.signal, registration.listener);
        }
      };
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`quiet-session failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
