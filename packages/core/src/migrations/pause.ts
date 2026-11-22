import type { ResolvedPath } from "../database-path.js";

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { readFileIdentity } from "../database-path.js";
import { CoreError, isMissingFileError } from "../errors.js";
import { syncDirectory, syncToDisk } from "../fs-sync.js";
import { attachSuppressed } from "../sqlite/database.js";

const pauseSchema = z.object({
  databaseFile: z.string(),
  startingVersion: z.number().int(),
  targetVersion: z.number().int(),
  backupPath: z.string(),
  published: z.boolean(),
});

type Pause = z.infer<typeof pauseSchema>;

function pausePath(databasePath: ResolvedPath) {
  return `${databasePath}.migration.json`;
}

export function readPauseRecord(databasePath: ResolvedPath) {
  try {
    return readFileSync(pausePath(databasePath), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

/** Called with the database write lock held */
export function removePause(databasePath: ResolvedPath, record: string) {
  if (readPauseRecord(databasePath) === record) {
    const path = pausePath(databasePath);
    rmSync(path);
    syncDirectory(dirname(path));
  }
}

function readPause(databasePath: ResolvedPath) {
  const path = pausePath(databasePath);

  try {
    const record = readPauseRecord(databasePath);
    return record === null ? null : pauseSchema.parse(JSON.parse(record));
  } catch (cause) {
    throw new CoreError(
      `Cannot read the automatic upgrade record at ${path}`,
      "storage",
      { entity: "database", databasePath, path },
      { cause },
    );
  }
}

function writePause(databasePath: ResolvedPath, pause: Pause) {
  const path = pausePath(databasePath);
  const partial = `${path}.${randomUUID()}.partial`;

  try {
    writeFileSync(partial, JSON.stringify(pause), { flag: "wx" });
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

/** Called before any automatic backup work with the database write lock held */
export function checkAutomaticUpgrade(
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

  const pause = readPause(databasePath);
  if (pause?.databaseFile === databaseFile && pause.startingVersion === startingVersion) {
    // The previous process can stop after the rename and before confirming publication
    const hasBackup =
      pause.published || statSync(pause.backupPath, { throwIfNoEntry: false }) !== undefined;
    if (hasBackup) {
      throw new CoreError(
        `Automatic upgrade of the database at ${databasePath} is paused after an incomplete attempt from schema ${startingVersion} to ${pause.targetVersion}`,
        "conflict",
        {
          entity: "database",
          databasePath,
          schemaVersion: startingVersion,
          supportedSchemaVersion: targetVersion,
          reason: "migration_paused",
        },
      );
    }
  }

  const attempt = { databaseFile, startingVersion, targetVersion };
  return {
    beforePublish: (backupPath: string) =>
      writePause(databasePath, { ...attempt, backupPath, published: false }),
    confirmed: (backupPath: string) =>
      writePause(databasePath, { ...attempt, backupPath, published: true }),
  };
}
