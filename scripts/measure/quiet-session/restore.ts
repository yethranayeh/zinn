/** Runs recorded undo commands, one by one, and reports each result separately. */

import type { RestoreEntry, RestoreState } from "./state.ts";
import type { CommandResult, Runner } from "./runner.ts";

import { existsSync } from "node:fs";
import { readRestoreState, removeRestoreState } from "./state.ts";

export type RestoreResult = {
  entry: RestoreEntry;
  exitCode: number;
  stderr: string;
  ok: boolean;
  error?: string;
};

export type RestoreCallbacks = {
  before?: (entry: RestoreEntry, index: number, total: number) => void;
  after?: (result: RestoreResult, index: number, total: number) => void;
};

/** Undoes entries in reverse application order. A failure never stops the remaining entries. */
export async function restoreEntries<T extends RestoreEntry>(
  runner: Runner,
  entries: readonly T[],
  callbacks: RestoreCallbacks = {},
  undo?: (entry: T) => Promise<CommandResult>,
): Promise<Array<RestoreResult>> {
  const results: Array<RestoreResult> = [];
  const ordered = [...entries].reverse();

  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]!;
    try {
      callbacks.before?.(entry, index, ordered.length);
    } catch {
      // Reporting must never stop a restore.
    }

    let result: RestoreResult;
    try {
      const commandResult = await (undo === undefined ? runner.capture(entry.undo) : undo(entry));
      result = {
        entry,
        exitCode: commandResult.exitCode,
        stderr: commandResult.stderr,
        ok: commandResult.exitCode === 0,
      };
    } catch (error) {
      result = {
        entry,
        exitCode: 1,
        stderr: "",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    results.push(result);
    try {
      callbacks.after?.(result, index, ordered.length);
    } catch {
      // Reporting must never stop a restore.
    }
  }
  return results;
}

export type RestoreOptions = {
  runner: Runner;
  statePath: string;
  write: (text: string) => void;
};

/** The `restore` command: undo a session that died before it could restore itself. */
export async function runRestoreCommand(options: RestoreOptions): Promise<number> {
  const { runner, statePath, write } = options;
  if (!existsSync(statePath)) {
    write(`No restore state file at ${statePath}.\n`);
    return 0;
  }

  let state: RestoreState;
  try {
    state = readRestoreState(statePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(`Could not read the restore state file: ${message}\n`);
    write(`State file kept at ${statePath}.\n`);
    return 1;
  }

  write(`Restoring session ${state.sessionId} from ${statePath}.\n`);
  if (state.changes.length === 0) {
    removeRestoreState(statePath);
    write("No changes were recorded. Removed the restore state file.\n");
    return 0;
  }

  const needsSudo = state.changes.some((entry) => entry.undo[0] === "sudo");
  if (needsSudo) {
    const sudoResult = await runner.interactive(["sudo", "-v"]);
    if (sudoResult.exitCode !== 0) {
      write(
        `sudo was not granted (exit ${sudoResult.exitCode}). State file kept at ${statePath}.\n`,
      );
      writeManualCommands(state, write);
      return 1;
    }
  }

  const results = await restoreEntries(runner, state.changes, {
    before: (entry, index, total) => {
      write(`[${index + 1}/${total}] ${entry.label}: ${entry.undoCommand}\n`);
    },
    after: (result, index, total) => {
      write(`[${index + 1}/${total}] exit ${result.exitCode}${result.ok ? "" : " (failed)"}\n`);
      const stderr = result.error ?? result.stderr.trim();
      if (stderr.length > 0) {
        write(`${stderr}\n`);
      }
    },
  });

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    write(`${failed.length} of ${results.length} restore commands failed.\n`);
    write(`State file kept at ${statePath}.\n`);
    writeManualCommands(state, write);
    return 1;
  }

  removeRestoreState(statePath);
  write(`Restored all ${results.length} changes. Removed ${statePath}.\n`);
  return 0;
}

export function writeManualCommands(state: RestoreState, write: (text: string) => void): void {
  write("Manual undo commands:\n");
  for (const entry of [...state.changes].reverse()) {
    write(`  ${entry.undoCommand}\n`);
  }
}
