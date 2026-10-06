/**
 * Estimates the free disk space an upgrade needs.
 * The estimate is only advisory, so rollback is still
 *  the actual protection layer when the real demand is higher
 */
import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";

import { statfsSync, statSync } from "node:fs";

import { SEARCH_COMMENT_SEPARATOR } from "../search-entry";
import { readSchemaVersion } from "./runner";

// The guesses below were checked on small test boards. They are cautious estimates, not SQLite limits.

/**
 * Guesses found below are results from some small test boards
 *  generated as estimates to be cautious of.
 * They are not a representation of any real SQLite limits
 */

/** Guesswork: Room beyond the copied rows for each new copy's own bookkeeping pages. */
const REPLACEMENT_EXTRA_PAGES = 16;
/** Guesswork: The search index stores the text and a word list pointing into it: up to about 4 times the text. */
const SEARCH_PAYLOAD_MULTIPLIER = 4;
/** Guesswork: Bytes the search index adds per task on top of its text. */
const SEARCH_ROW_OVERHEAD_BYTES = 128;
/** Guesswork: Each page written also lands in the -wal file, and copying then dropping writes some pages twice. */
const WAL_FRAMES_PER_REPLACEMENT_PAGE = 2;
/** Guesswork: Flat room for small files and headers SQLite may add along the way. */
const FIXED_OVERHEAD_BYTES = 64 * 1024;
/** The -wal file starts with a header of this size @link https://www.sqlite.org/fileformat2.html#wal_file_format */
const WAL_HEADER_BYTES = 32;
/** Each page in the -wal file comes after a header of this size @link https://www.sqlite.org/fileformat2.html#wal_file_format */
const WAL_FRAME_HEADER_BYTES = 24;
/** The -shm file, SQLite's lookup table for the -wal file, grows in steps of this size @link https://www.sqlite.org/walformat.html */
const SHM_UNIT_BYTES = 32 * 1024;
/** Pages the first -shm step can list; its header takes part of the step @link https://www.sqlite.org/walformat.html */
const SHM_FIRST_UNIT_ENTRIES = 4062;
/** Pages each later -shm step can list @link https://www.sqlite.org/walformat.html */
const SHM_LATER_UNIT_ENTRIES = 4096;
/** Require twice the estimate, since it is a guess and not a measured bound. */
const REQUIRED_FREE_HEADROOM = 2;

/** The tables SQLite keeps behind the task_search index @link https://www.sqlite.org/fts5.html#fts5_data_structures */
const SEARCH_SHADOW_TABLES = ["data", "idx", "content", "docsize", "config"].map(
  (suffix) => `task_search_${suffix}`,
);

const SEPARATOR_BYTES = new TextEncoder().encode(SEARCH_COMMENT_SEPARATOR).length;
/** `stat.blocks` counts 512-byte blocks @link https://man7.org/linux/man-pages/man3/stat.3type.html */
const STAT_BLOCK_BYTES = 512;

/** What the estimate reads, taken while the migration lock is held. */
export type SpaceMeasurements = {
  /** The unit SQLite reads and writes the database in. */
  pageSize: number;
  /** The database's full size, counting changes still only in the -wal file. */
  databaseBytes: number;
  /** Whether a pending migration rebuilds tables. */
  rebuildsTables: boolean;
  /** The size of the tables the pending migrations rebuild, with their indexes. */
  rebuiltTableBytes: number;
  /** Whether a pending migration regenerates search. */
  regeneratesSearch: boolean;
  /** The size of the current search index. */
  searchIndexBytes: number;
  /** Bytes of the text search is built from: task ids, titles, descriptions and comments. */
  searchSourceBytes: number;
  taskCount: number;
  /** Disk space the database file already takes up, 0 when unknown. */
  allocatedMainBytes: number;
  walBytes: number;
  shmBytes: number;
};

/** Additional free bytes required on each filesystem, headroom included. */
export type RequiredFree = { database: number; backup: number; temporary: number };

function readNumber(db: Database, sql: string, params: Record<string, string> = {}) {
  return db.query<{ value: number | null }>(sql).get(params)?.value ?? 0;
}

function fileSize(path: string, read: (path: string) => number) {
  try {
    return read(path);
  } catch {
    return 0;
  }
}

/** The size of the tables and their indexes, or null when this SQLite build lacks the dbstat table that reports it. */
function readStructureBytes(db: Database, tables: ReadonlyArray<string>) {
  try {
    return readNumber(
      db,
      `SELECT SUM(pgsize) AS value FROM dbstat WHERE name IN
        (SELECT name FROM sqlite_schema WHERE tbl_name IN (SELECT value FROM json_each($tables)))`,
      { $tables: JSON.stringify(tables) },
    );
  } catch {
    return null;
  }
}

/** The file the connection's main database lives in, or null for an in-memory database. */
export function readDatabaseFile(db: Database) {
  const file = db
    .query<{ file: string }>("SELECT file FROM pragma_database_list WHERE name = 'main'")
    .get()?.file;

  return file == null || file === "" ? null : file;
}

/** The measurements that depend only on the database's system files */
export type FileMeasurements = Pick<
  SpaceMeasurements,
  "pageSize" | "databaseBytes" | "allocatedMainBytes" | "walBytes" | "shmBytes"
>;

/** Reads the sizes of the database file and its -wal and -shm files */
export function measureFiles(db: Database): FileMeasurements {
  const pageSize = readNumber(db, "SELECT page_size AS value FROM pragma_page_size");
  const databaseBytes =
    pageSize * readNumber(db, "SELECT page_count AS value FROM pragma_page_count");

  const mainPath = readDatabaseFile(db);
  const allocatedMainBytes =
    mainPath == null
      ? 0
      : fileSize(mainPath, (path) => (statSync(path).blocks ?? 0) * STAT_BLOCK_BYTES);

  return {
    pageSize,
    databaseBytes,
    allocatedMainBytes,
    walBytes: mainPath ? fileSize(`${mainPath}-wal`, (path) => statSync(path).size) : 0,
    shmBytes: mainPath ? fileSize(`${mainPath}-shm`, (path) => statSync(path).size) : 0,
  };
}

/** Reads the sizes of what the migrations after the database's version still have to do. */
export function measureSpace(
  db: Database,
  migrations: ReadonlyArray<Migration>,
): SpaceMeasurements {
  const version = readSchemaVersion(db);
  const pending = migrations.filter((migration) => migration.version > version);
  const files = measureFiles(db);
  const { databaseBytes } = files;

  // A table rebuilt by two migrations is copied twice, so it counts twice.
  const rebuiltTables = pending.flatMap((migration) => [...migration.rebuilds]);
  const rebuildsTables = rebuiltTables.length > 0;
  const regeneratesSearch = pending.some((migration) => migration.regeneratesSearch === true);

  // Without dbstat, the whole database's size stands in for the rebuilt tables and for the search index.
  const tableBytes = rebuiltTables.map((table) => readStructureBytes(db, [table]));
  const rebuiltTableBytes = tableBytes.includes(null)
    ? databaseBytes
    : tableBytes.reduce<number>((total, bytes) => total + (bytes ?? 0), 0);
  const searchIndexBytes = regeneratesSearch
    ? (readStructureBytes(db, SEARCH_SHADOW_TABLES) ?? databaseBytes)
    : 0;

  // length(CAST(x AS BLOB)) counts bytes, not characters. Separators come from comment rows, not task.comment_count.
  const textBytes = readNumber(
    db,
    `SELECT (SELECT COALESCE(SUM(length(CAST(id AS BLOB)) + length(CAST(title AS BLOB))
        + COALESCE(length(CAST(description AS BLOB)), 0)), 0) FROM task)
      + (SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) FROM comment) AS value`,
  );
  const commentedTasks = readNumber(db, "SELECT COUNT(DISTINCT task_id) AS value FROM comment");
  const commentCount = readNumber(db, "SELECT COUNT(*) AS value FROM comment");
  const separatorBytes = (commentCount - commentedTasks) * SEPARATOR_BYTES;

  return {
    ...files,
    rebuildsTables,
    rebuiltTableBytes,
    regeneratesSearch,
    searchIndexBytes,
    searchSourceBytes: textBytes + separatorBytes,
    taskCount: readNumber(db, "SELECT COUNT(*) AS value FROM task"),
  };
}

function roundUpTo(unit: number, bytes: number) {
  return Math.ceil(bytes / unit) * unit;
}

function walFrameCount(walBytes: number, pageSize: number) {
  return Math.ceil(Math.max(0, walBytes - WAL_HEADER_BYTES) / (pageSize + WAL_FRAME_HEADER_BYTES));
}

/** @link https://www.sqlite.org/walformat.html */
function walIndexBytes(frames: number) {
  const laterUnits = Math.ceil(
    Math.max(0, frames - SHM_FIRST_UNIT_ENTRIES) / SHM_LATER_UNIT_ENTRIES,
  );
  return SHM_UNIT_BYTES * (1 + laterUnits);
}

/**
 * The free bytes the remaining work needs.
 * Before the backup, include it. After the backup, measure again and leave it out:
 * the finished snapshot already occupies its space.
 */
export function estimateRequiredFree(
  measurements: SpaceMeasurements,
  options: { includeBackup: boolean },
): RequiredFree {
  const { pageSize, databaseBytes } = measurements;
  const extraPages = REPLACEMENT_EXTRA_PAGES * pageSize;

  const tablesReplacement = measurements.rebuildsTables
    ? measurements.rebuiltTableBytes + extraPages
    : 0;
  const searchPayload =
    SEARCH_PAYLOAD_MULTIPLIER *
    (measurements.searchSourceBytes + SEARCH_ROW_OVERHEAD_BYTES * measurements.taskCount);
  const searchReplacement = measurements.regeneratesSearch
    ? roundUpTo(pageSize, Math.max(measurements.searchIndexBytes, searchPayload)) + extraPages
    : 0;
  // The old tables and index stay in place until the new copies are complete.
  const replacement = tablesReplacement + searchReplacement;

  // The database file grows by the new copies, and by changes it has yet to take over from the -wal file.
  const mainFileGrowth = Math.max(0, databaseBytes + replacement - measurements.allocatedMainBytes);
  const newFrames = Math.ceil((WAL_FRAMES_PER_REPLACEMENT_PAGE * replacement) / pageSize);
  const walBytes = WAL_HEADER_BYTES + newFrames * (pageSize + WAL_FRAME_HEADER_BYTES);
  const existingFrames = walFrameCount(measurements.walBytes, pageSize);
  const walIndexGrowth = Math.max(
    0,
    walIndexBytes(existingFrames + newFrames) - measurements.shmBytes,
  );
  const fixedOverhead = FIXED_OVERHEAD_BYTES + walIndexGrowth;

  return {
    database: REQUIRED_FREE_HEADROOM * (mainFileGrowth + walBytes + fixedOverhead),
    backup: options.includeBackup ? REQUIRED_FREE_HEADROOM * databaseBytes : 0,
    // SQLite's temporary files while copying and building the index.
    temporary: REQUIRED_FREE_HEADROOM * replacement,
  };
}

/** What a filesystem offers: free bytes, its allocation unit and an identity to tell which paths share it. */
export type FreeSpace = { availableBytes: number; blockBytes: number; device: number | bigint };

export function readFreeSpace(path: string): FreeSpace | null {
  try {
    const { bavail, bsize } = statfsSync(path);
    const availableBytes = bavail * bsize;

    if (!Number.isFinite(availableBytes)) {
      return null;
    }

    return { availableBytes, blockBytes: bsize, device: statSync(path).dev };
  } catch {
    return null;
  }
}

export type SpacePaths = { database: string; backup: string; temporary: string };

/**
 * Throws when a filesystem lacks the space, naming its path and the bytes required and available.
 * Paths on one filesystem share their allowances; a path whose space cannot be read is an error too.
 */
export function assertFreeSpace(
  paths: SpacePaths,
  required: RequiredFree,
  read: (path: string) => FreeSpace | null = readFreeSpace,
) {
  const filesystems: Array<{ paths: Array<string>; space: FreeSpace; required: number }> = [];

  for (const key of ["database", "backup", "temporary"] as const) {
    const path = paths[key];
    const space = read(path);

    if (space == null) {
      throw new Error(
        `The free disk space at ${path} is unknown, and ${required[key]} bytes are required`,
      );
    }

    const shared = filesystems.find((filesystem) => filesystem.space.device === space.device);

    if (shared == null) {
      filesystems.push({ paths: [path], space, required: required[key] });
    } else {
      shared.paths.push(path);
      shared.required += required[key];
    }
  }

  for (const filesystem of filesystems) {
    const requiredBytes = roundUpTo(filesystem.space.blockBytes, filesystem.required);

    if (filesystem.space.availableBytes < requiredBytes) {
      throw new Error(
        `Not enough free disk space at ${filesystem.paths.join(", ")}: ${requiredBytes} bytes are required and ${filesystem.space.availableBytes} are available`,
      );
    }
  }
}
