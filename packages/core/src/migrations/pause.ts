import type { ResolvedPath } from "../database-path.js";
import type { Database } from "../sqlite/database.js";

import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { readFileIdentity } from "../database-path.js";
import { CoreError, isMissingFileError } from "../errors.js";
import { syncDirectory, syncToDisk } from "../fs-sync.js";
import { attachSuppressed } from "../sqlite/database.js";

const pauseSchema = z.object({
  databaseFile: z.string(),
  /** SQLite's schema cookie, which every committed schema change and every `VACUUM INTO` copy moves */
  schemaCookie: z.number().int(),
  startingVersion: z.number().int(),
  targetVersion: z.number().int(),
  backupPath: z.string(),
  published: z.boolean(),
});

type Pause = z.infer<typeof pauseSchema>;

type ReadPause =
  | { state: "none" }
  | { state: "pause"; pause: Pause; record: string }
  | { state: "unreadable"; cause: unknown };

/**
 * An automatic upgrade failed after saving its backup, so later automatic upgrades of the database are paused.
 * The failure is the cause.
 */
export class AutomaticUpgradePausedError extends Error {
  override name = "AutomaticUpgradePausedError";
}

/** Errors from an automatic upgrade that failed after its backup was published, and so paused retries */
const pausingFailures = new WeakSet<Error>();

function pausePath(databasePath: ResolvedPath) {
  return `${databasePath}.migration.json`;
}

function readSchemaCookie(db: Database) {
  return db.query<{ schema_version: number }>("PRAGMA schema_version").get()!.schema_version;
}

/** A file at the record's path that is not a pause record, or cannot be read, counts as unreadable */
function readPause(databasePath: ResolvedPath): ReadPause {
  let record: string;

  try {
    record = readFileSync(pausePath(databasePath), "utf8");
  } catch (cause) {
    return isMissingFileError(cause) ? { state: "none" } : { state: "unreadable", cause };
  }

  try {
    return { state: "pause", pause: pauseSchema.parse(JSON.parse(record)), record };
  } catch (cause) {
    return { state: "unreadable", cause };
  }
}

/**
 * The pause record a committed upgrade or restore may remove, or `null`.
 * Called inside the write transaction. An unrelated or unreadable file at the record's path
 *  neither stops the change nor gets removed.
 */
export function readOwnPause(databasePath: ResolvedPath) {
  const read = readPause(databasePath);
  return read.state === "pause" ? read.record : null;
}

/** Called with the database write lock held */
export function removePause(databasePath: ResolvedPath, record: string) {
  const read = readPause(databasePath);

  if (read.state === "pause" && read.record === record) {
    const path = pausePath(databasePath);
    rmSync(path);
    syncDirectory(dirname(path));
  }
}

function writePause(databasePath: ResolvedPath, pause: Pause) {
  const path = pausePath(databasePath);
  // A fixed name, since the write lock is held, so an interrupted write leaves at most one file
  const partial = `${path}.partial`;

  try {
    writeFileSync(partial, JSON.stringify(pause));
    syncToDisk(partial);
    renameSync(partial, path);
    syncDirectory(dirname(path));
  } catch (error) {
    try {
      rmSync(partial, { force: true });
    } catch (cleanupError) {
      attachSuppressed(error, cleanupError);
    }
    throw error;
  }
}

function hasBackup(pause: Pause) {
  if (pause.published) {
    return true;
  }

  // The previous process can stop after the rename and before confirming publication
  try {
    return statSync(pause.backupPath, { throwIfNoEntry: false }) !== undefined;
  } catch {
    // A backup that cannot be checked may exist, so the pause holds
    return true;
  }
}

function pausedError(
  databasePath: ResolvedPath,
  startingVersion: number,
  targetVersion: number,
  message: string,
  extra: { path?: string; cause?: unknown } = {},
) {
  const { path, cause } = extra;
  return new CoreError(
    message,
    "conflict",
    {
      entity: "database",
      databasePath,
      schemaVersion: startingVersion,
      supportedSchemaVersion: targetVersion,
      reason: "migration_paused",
      ...(path === undefined ? {} : { path }),
    },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Called inside the write transaction, before any automatic backup work.
 * A record pauses only the same database file with the same schema at the same version,
 *  so a restore or a replaced file permits a fresh attempt.
 */
export function checkAutomaticUpgrade(
  db: Database,
  databasePath: ResolvedPath,
  startingVersion: number,
  targetVersion: number,
) {
  const databaseFile = readFileIdentity(databasePath);
  if (databaseFile === null) {
    throw new CoreError(
      `Cannot record an automatic upgrade for the missing database at ${databasePath}`,
      "storage",
      { entity: "database", databasePath },
    );
  }

  const schemaCookie = readSchemaCookie(db);
  const read = readPause(databasePath);

  // Without a readable record, a failed attempt could not pause the next one
  if (read.state === "unreadable") {
    const path = pausePath(databasePath);
    throw pausedError(
      databasePath,
      startingVersion,
      targetVersion,
      `Automatic upgrade of the database at ${databasePath} is paused because the file at ${path} is not an upgrade record Zinn can read`,
      { path, cause: read.cause },
    );
  }

  if (read.state === "pause") {
    const { pause } = read;
    const isSameAttempt =
      pause.databaseFile === databaseFile &&
      pause.schemaCookie === schemaCookie &&
      pause.startingVersion === startingVersion;

    if (isSameAttempt && hasBackup(pause)) {
      throw pausedError(
        databasePath,
        startingVersion,
        targetVersion,
        `Automatic upgrade of the database at ${databasePath} is paused after an incomplete attempt from schema ${startingVersion} to ${pause.targetVersion}`,
      );
    }
  }

  const attempt = { databaseFile, schemaCookie, startingVersion, targetVersion };
  return {
    beforePublish: (backupPath: string) =>
      writePause(databasePath, { ...attempt, backupPath, published: false }),
    confirmed: (backupPath: string) =>
      writePause(databasePath, { ...attempt, backupPath, published: true }),
  };
}

export function markPausingFailure(error: unknown) {
  if (error instanceof Error) {
    pausingFailures.add(error);
  }
}

/** Whether the error failed an automatic upgrade that now pauses later automatic attempts */
export function isPausingFailure(error: unknown) {
  return error instanceof Error && pausingFailures.has(error);
}
