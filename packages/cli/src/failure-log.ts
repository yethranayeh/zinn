import type { ConfiguredStorage } from "@zinn-dev/core";

import { closeSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import {
  createOutputFileName,
  getConfiguredStorage,
  getStorage,
  readOutputFileName,
  readSchemaVersionWithoutWaiting,
} from "@zinn-dev/core";

import packageJson from "../package.json" with { type: "json" };
import { currentRuntime, readRunClock } from "./run-facts.js";
import { ensureFolderInStore } from "./store-folder.js";

const LOG_EXTENSION = ".log";
/** Logs kept in the folder. Including ones written by a failing run */
const MAX_LOG_FILES = 10;

/** One thrown value as text. An error keeps its stack, and its code and `errcode` when it has them */
function describeValue(value: unknown) {
  if (!(value instanceof Error)) {
    return String(value);
  }

  const lines = [typeof value.stack === "string" ? value.stack : `${value.name}: ${value.message}`];
  const { code, errcode } = value as { code?: unknown; errcode?: unknown };
  if (code !== undefined) {
    lines.push(`code: ${String(code)}`);
  }

  if (errcode !== undefined) {
    lines.push(`errcode: ${String(errcode)}`);
  }

  return lines.join("\n");
}

/** The thrown error, then each cause and suppressed error, stopping at one already shown */
function describeErrors(error: unknown) {
  const shown = new Set<unknown>();
  const entries: Array<string> = [];

  const add = (value: unknown, label: string | null) => {
    if (shown.has(value)) {
      return;
    }

    shown.add(value);
    entries.push(label === null ? describeValue(value) : `${label}\n${describeValue(value)}`);

    if (!(value instanceof Error)) {
      return;
    }

    const { suppressed } = value as { suppressed?: unknown };
    if (value.cause !== undefined) {
      add(value.cause, "Caused by:");
    }

    if (suppressed !== undefined) {
      add(suppressed, "Suppressed:");
    }
  };

  add(error, null);
  return entries.join("\n\n");
}

function describeRuntime() {
  const { name, version } = currentRuntime();
  return `${name} ${version}`;
}

function section(title: string, lines: Array<string>) {
  return [title, ...lines].join("\n");
}

/** The resolved database path and its schema version, or the configured path when it cannot be resolved. */
function readDatabaseFacts(configuredPath: string) {
  try {
    const { databasePath } = getStorage();
    return { databasePath, schemaVersion: readSchemaVersionWithoutWaiting(databasePath) };
  } catch {
    return { databasePath: configuredPath, schemaVersion: null };
  }
}

function formatLog(error: unknown, notices: ReadonlyArray<string>, storage: ConfiguredStorage) {
  const { databasePath, schemaVersion } = readDatabaseFacts(storage.databasePath);
  const { now: failedAt, elapsedMs, startedAt } = readRunClock();

  const sections = [
    section("Error", [describeErrors(error)]),
    section("Run", [
      `Process id: ${process.pid}`,
      `Zinn version: ${packageJson.version}`,
      `Runtime: ${describeRuntime()}`,
      `Operating system: ${platform()} ${release()} ${arch()}`,
    ]),
    section("Store", [
      `Directory: ${storage.directory}`,
      `Database: ${databasePath}`,
      `Schema version: ${schemaVersion ?? "unknown"}`,
    ]),
    section("Arguments", [JSON.stringify(process.argv.slice(2))]),
    section("Timings", [
      `Started: ${startedAt.toISOString()}`,
      `Failed: ${failedAt.toISOString()}`,
      `Elapsed: ${elapsedMs} ms`,
    ]),
  ];

  if (notices.length > 0) {
    sections.push(section("Notices", [...notices]));
  }

  return `${sections.join("\n\n")}\n`;
}

/** Creates a file that does not exist yet, and removes it again when its text cannot be written */
function createFile(path: string, text: string) {
  const descriptor = openSync(path, "wx");
  let isWritten = false;

  try {
    try {
      writeFileSync(descriptor, text);
    } finally {
      closeSync(descriptor);
    }
    isWritten = true;
  } finally {
    if (!isWritten) {
      rmSync(path, { force: true });
    }
  }
}

/** Other runs' logs, oldest first by modification time, then by name */
function listOtherLogs(logDirectory: string, ownName: string) {
  return readdirSync(logDirectory)
    .filter((name) => name !== ownName && readOutputFileName(name, LOG_EXTENSION) !== null)
    .flatMap((name) => {
      try {
        return [{ name, modifiedMs: statSync(join(logDirectory, name)).mtimeMs }];
      } catch {
        // Another run may have removed it since the listing
        return [];
      }
    })
    .sort((a, b) => a.modifiedMs - b.modifiedMs || a.name.localeCompare(b.name))
    .map(({ name }) => name);
}

/** Removes the oldest logs so that at most `MAX_LOG_FILES` remain. Other files stay */
function removeOldLogs(logDirectory: string, ownName: string) {
  try {
    const others = listOtherLogs(logDirectory, ownName);
    const excess = others.length - (MAX_LOG_FILES - 1);

    for (const name of others.slice(0, Math.max(excess, 0))) {
      try {
        rmSync(join(logDirectory, name), { force: true });
      } catch {
        // Another run may have removed it, and a leftover only keeps one more file
      }
    }
  } catch {
    // The new log is already written, so a failed listing only skips the cleanup
  }
}

/**
 * Writes what a failure leaves out of its error message to a new file in the store's `logs` folder.
 * Returns the file's path, or undefined when none was written. It never throws,
 *  so logging cannot hide the failure it reports.
 */
export function writeFailureLog(
  error: unknown,
  notices: ReadonlyArray<string>,
): string | undefined {
  try {
    const storage = getConfiguredStorage();
    const name = createOutputFileName(
      { client: "cli", version: packageJson.version },
      LOG_EXTENSION,
    );
    const path = join(storage.logDirectory, name);
    const text = formatLog(error, notices, storage);

    ensureFolderInStore(storage.logDirectory);
    createFile(path, text);
    removeOldLogs(storage.logDirectory, name);

    return path;
  } catch {
    return undefined;
  }
}
