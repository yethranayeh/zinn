/**
 * Writes counts from one Zinn backup to docs/src/config/stats.json for the website's Stats page.
 *
 * Usage: `bun run stats-export <backup-file> [--backups <folder>]`
 *
 * Reads:
 * - `<backup-file>`, a file that `zinn backup` named, such as `2026-09-29T12-30-05Z-cli-0.32.0-b38178c0.sqlite`.
 *   Any other name is refused. The file is copied to a new temporary folder and only the copy is opened,
 *   since opening a database through core changes its journal files. The folder is removed afterwards.
 * - The file names in `--backups <folder>`, the folder of `<backup-file>` by default. Those files are never opened.
 *
 * Writes `docs/src/config/stats.json`, tab-indented, only when its content changed.
 * It exits non-zero without writing when the copy is not at the latest schema version,
 * fails either integrity check, or its replayed column history does not match its current board.
 *
 * Only the projects in `STATS_PROJECTS` appear, read one at a time by project key.
 * The output holds counts and the names of actions, entity types, actor kinds, host families, models and columns.
 * No title, description, comment, key, label, actor name, email, session, thread or row ID is copied into it.
 *
 * Shape:
 * - `format`: 1.
 * - `snapshot.takenAt`: the UTC time at the start of the backup's file name.
 * - `snapshot.schemaVersion`: the copy's schema version.
 * - `snapshot.migrationsApplied`: how many of core's migrations have a version at or below it.
 * - `snapshot.integrityCheck`: what `PRAGMA integrity_check` returned, `ok` when sound.
 * - `snapshot.foreignKeyViolations`: the number of rows `PRAGMA foreign_key_check` returned.
 * - `backups.count`: `.sqlite` files in the backups folder whose name starts with a backup time.
 * - `backups.first`, `backups.last`: the earliest and latest of those times.
 * - `backups.cliVersions`: each CLI version named in those file names, with whether it is a prerelease
 *   and how many backups it made, ordered by its earliest backup. A name the CLI no longer writes adds no version.
 * - `firstTask`: whether task 1 of the oldest listed project still exists, with its `createdAt` when it does.
 * - `projects[]`, in `STATS_PROJECTS` order:
 *   - `key`, `kind`: the project key and its group on the page.
 *   - `createdAt`: when the project was created.
 *   - `columns`: current column names in board order.
 *   - `tasks.total`, `tasks.archived`: task counts now. Archived tasks are part of `total`.
 *   - `tasks.byColumn`: task counts now per column in board order, archived tasks included, so they sum to `total`.
 *   - `hours[]`: one row per UTC hour that has something to report, ascending. Each row has:
 *     - `hour`: the hour's start.
 *     - `tasksCreated`: tasks still present that were created in the hour.
 *     - `actions`: events per `<entity_type>.<action>`, such as `task.move`.
 *     - `actorKinds`: events per actor kind, `agent` or `human`.
 *     - `hosts`: agent events per host family, read from the actor name.
 *       Families are `STATS_HOST_FAMILIES`, and every other agent name counts as `other`.
 *     - `models`: agent events per recorded model. Agent events without a model are left out,
 *       so `actorKinds.agent` minus the sum of `models` is the number without one.
 *     - `columns`: the net change in tasks per column name in the hour, positive or negative.
 *       Summed over all hours it gives `tasks.byColumn`. Tasks created before activity was recorded
 *       enter at their creation time, and a deleted task without a recorded creation is left out.
 *   Zero counts and empty maps are left out of a row. Keys inside count maps are sorted.
 * Instants are UTC ISO 8601 to the second, such as `2026-10-16T22:00:00Z`.
 */
import type { Activity, TaskWithKey } from "../packages/core/index.ts";

import { Database } from "bun:sqlite";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  activity,
  column,
  info,
  project,
  readOutputFileName,
  task,
} from "../packages/core/index.ts";
import { MIGRATIONS } from "../packages/core/src/migrations/registry.ts";
import { isPrerelease } from "../packages/core/src/release.ts";

export const STATS_PATH = fileURLToPath(new URL("../docs/src/config/stats.json", import.meta.url));

export type StatsProject = { key: string; kind: string };

/** The projects that appear on the page, in output order. */
export const STATS_PROJECTS: ReadonlyArray<StatsProject> = [
  { key: "ZINN", kind: "core" },
  { key: "ZSH", kind: "website" },
  { key: "ZOC", kind: "integrations" },
  { key: "ZART", kind: "art" },
];

export const STATS_HOST_FAMILIES = ["claude-code", "codex", "opencode"] as const;
const OTHER_HOST_FAMILY = "other";
const STATS_FORMAT = 1;
const BACKUP_EXTENSION = ".sqlite";
const SOUND_INTEGRITY_CHECK = "ok";
const ACTIVITY_PAGE_SIZE = 1000;
const MILLISECONDS_PER_HOUR = 3_600_000;
/** `2026-10-16T22:00:00.000Z` without its milliseconds. */
const ISO_SECONDS_LENGTH = 19;
/** The UTC time at the start of a backup file name, such as `2026-11-09T19-32-42Z`. */
const BACKUP_TIME =
  /^(?<date>\d{4}-\d{2}-\d{2})T(?<hours>\d{2})-(?<minutes>\d{2})-(?<seconds>\d{2})Z/;

type CountMap = Record<string, number>;

export type HourRow = {
  hour: string;
  tasksCreated?: number;
  actions?: CountMap;
  actorKinds?: CountMap;
  hosts?: CountMap;
  models?: CountMap;
  columns?: CountMap;
};

export type ProjectStats = {
  key: string;
  kind: string;
  createdAt: string;
  columns: Array<string>;
  tasks: { total: number; archived: number; byColumn: CountMap };
  hours: Array<HourRow>;
};

export type FirstTask = { present: true; createdAt: string } | { present: false };

export type BackupStats = {
  count: number;
  first: string | null;
  last: string | null;
  cliVersions: Array<{ version: string; prerelease: boolean; backups: number }>;
};

/** A UTC instant to the second, such as `2026-10-16T22:42:07Z`. */
export function toInstant(milliseconds: number) {
  return `${new Date(milliseconds).toISOString().slice(0, ISO_SECONDS_LENGTH)}Z`;
}

/** The start of the UTC hour that holds `milliseconds`, as an instant. */
export function toHour(milliseconds: number) {
  return toInstant(Math.floor(milliseconds / MILLISECONDS_PER_HOUR) * MILLISECONDS_PER_HOUR);
}

/** The instant at the start of a backup file name, or null when the name does not start with one. */
export function readBackupTime(fileName: string) {
  const time = BACKUP_TIME.exec(fileName)?.groups;
  if (time === undefined) {
    return null;
  }

  return `${time.date}T${time.hours}:${time.minutes}:${time.seconds}Z`;
}

/** The host family of an agent's name. A name belongs to a family when it is the family or starts with it and `_` or `-`. */
export function readHostFamily(actorName: string | null) {
  const family = STATS_HOST_FAMILIES.find(
    (name) =>
      actorName === name || actorName?.startsWith(`${name}_`) || actorName?.startsWith(`${name}-`),
  );

  return family ?? OTHER_HOST_FAMILY;
}

/** Backup count, time range and CLI versions from the file names in a backups folder. */
export function summarizeBackups(fileNames: Array<string>): BackupStats {
  const backups = fileNames
    .filter((name) => name.endsWith(BACKUP_EXTENSION))
    .flatMap((name) => {
      const time = readBackupTime(name);
      return time === null ? [] : [{ name, time }];
    })
    .sort((left, right) => left.time.localeCompare(right.time));
  const versions = new Map<string, number>();

  for (const { name } of backups) {
    const identity = readOutputFileName(name, BACKUP_EXTENSION);
    if (identity?.client === "cli") {
      versions.set(identity.version, (versions.get(identity.version) ?? 0) + 1);
    }
  }

  return {
    count: backups.length,
    first: backups[0]?.time ?? null,
    last: backups.at(-1)?.time ?? null,
    // A Map keeps insertion order, which is the order of each version's earliest backup.
    cliVersions: [...versions].map(([version, count]) => ({
      version,
      prerelease: isPrerelease(version),
      backups: count,
    })),
  };
}

/** Every event of one project through `activity.getAll`, oldest first. */
function readProjectEvents(projectKey: string) {
  const events: Array<Activity> = [];
  let startingAfter: string | undefined;

  do {
    const page = activity.getAll({ projectKey, limit: ACTIVITY_PAGE_SIZE, startingAfter });
    events.push(...page.events);
    startingAfter = page.hasMore ? page.nextCursor : undefined;
  } while (startingAfter !== undefined);

  return events.reverse();
}

type ColumnSnapshot = { id: string; name: string };

/** A `{ id, name }` column recorded in an event, or null for any other value. */
function readColumnSnapshot(value: unknown): ColumnSnapshot | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { id, name } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string") {
    return null;
  }

  return { id, name };
}

/** The source and destination columns of a task move event. */
function readMoveColumns(event: Activity) {
  const columns = event.changes?.column;
  if (!Array.isArray(columns)) {
    return null;
  }

  const source = readColumnSnapshot(columns[0]);
  const destination = readColumnSnapshot(columns[1]);
  if (source === null || destination === null) {
    return null;
  }

  return { source, destination };
}

type ColumnChange = { at: number; columnId: string; change: number };

/**
 * Replays each task's column history as changes by column ID.
 * A task enters its starting column at its creation, each move takes it from the source to the destination,
 * and a delete takes it from the column it was in.
 * @param events Task events of one project, oldest first.
 */
function replayColumnChanges(events: Array<Activity>, tasks: Array<TaskWithKey>) {
  const eventsByTask = new Map<string, Array<Activity>>();
  for (const event of events) {
    const taskEvents = eventsByTask.get(event.entity_id) ?? [];
    taskEvents.push(event);
    eventsByTask.set(event.entity_id, taskEvents);
  }

  const currentTasks = new Map(tasks.map((entry) => [entry.id, entry]));
  const changes: Array<ColumnChange> = [];

  for (const [taskId, taskEvents] of eventsByTask) {
    const currentTask = currentTasks.get(taskId);
    const createEvent = taskEvents.find((event) => event.action === "create");
    const createdColumn = readColumnSnapshot(createEvent?.changes?.column);
    const firstMove = taskEvents
      .filter((event) => event.action === "move")
      .map(readMoveColumns)
      .find((move) => move !== null);
    const isDeletedWithoutCreation = currentTask === undefined && createEvent === undefined;

    if (isDeletedWithoutCreation) {
      continue;
    }

    let columnId = createdColumn?.id ?? firstMove?.source.id ?? currentTask?.column_id ?? null;
    if (columnId === null) {
      continue;
    }
    changes.push({ at: currentTask?.created_at ?? createEvent!.created_at, columnId, change: 1 });

    for (const event of taskEvents) {
      if (event.action === "move") {
        const move = readMoveColumns(event);
        if (move !== null) {
          changes.push({ at: event.created_at, columnId: move.source.id, change: -1 });
          changes.push({ at: event.created_at, columnId: move.destination.id, change: 1 });
          columnId = move.destination.id;
        }
      } else if (event.action === "delete") {
        changes.push({ at: event.created_at, columnId, change: -1 });
      }
    }
  }

  for (const currentTask of tasks) {
    if (!eventsByTask.has(currentTask.id)) {
      changes.push({ at: currentTask.created_at, columnId: currentTask.column_id, change: 1 });
    }
  }

  return changes;
}

/** Column names from recorded events, for columns that no longer exist. */
function readRecordedColumnNames(events: Array<Activity>) {
  const names = new Map<string, string>();
  for (const event of events) {
    const snapshots =
      event.action === "move"
        ? Object.values(readMoveColumns(event) ?? {})
        : [readColumnSnapshot(event.changes?.column)];
    for (const snapshot of snapshots) {
      if (snapshot !== null) {
        names.set(snapshot.id, snapshot.name);
      }
    }
  }

  return names;
}

function increment(counts: Map<string, number>, key: string, amount = 1) {
  counts.set(key, (counts.get(key) ?? 0) + amount);
}

/** The non-zero counts as an object with sorted keys. */
function toCountMap(counts: Map<string, number>): CountMap {
  return Object.fromEntries(
    [...counts]
      .filter(([, count]) => count !== 0)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

type HourCounts = {
  tasksCreated: number;
  actions: Map<string, number>;
  actorKinds: Map<string, number>;
  hosts: Map<string, number>;
  models: Map<string, number>;
  columns: Map<string, number>;
};

/** Reads one project's figures through core. The store must already be selected. */
export function summarizeProject({ key, kind }: StatsProject): ProjectStats {
  const projectRecord = project.getByKey(key);
  if (projectRecord == null) {
    throw new Error(`Project ${key} does not exist in the snapshot`);
  }

  const events = readProjectEvents(key);
  const tasks = task.getAll({ projectKey: key, archive: "all" });
  const boardColumns = column.getAllByProjectKey(key);
  const hours = new Map<string, HourCounts>();
  const hourCounts = (milliseconds: number) => {
    const hour = toHour(milliseconds);
    let counts = hours.get(hour);
    if (counts === undefined) {
      counts = {
        tasksCreated: 0,
        actions: new Map(),
        actorKinds: new Map(),
        hosts: new Map(),
        models: new Map(),
        columns: new Map(),
      };
      hours.set(hour, counts);
    }
    return counts;
  };

  for (const event of events) {
    const counts = hourCounts(event.created_at);
    increment(counts.actions, `${event.entity_type}.${event.action}`);
    increment(counts.actorKinds, event.actor_kind);
    if (event.actor_kind === "agent") {
      increment(counts.hosts, readHostFamily(event.actor_name));
      if (event.actor_model !== null) {
        increment(counts.models, event.actor_model);
      }
    }
  }

  for (const entry of tasks) {
    hourCounts(entry.created_at).tasksCreated += 1;
  }

  const taskEvents = events.filter((event) => event.entity_type === "task");
  const currentNames = new Map(boardColumns.map((entry) => [entry.id, entry.name]));
  const recordedNames = readRecordedColumnNames(taskEvents);
  const columnName = (columnId: string) => {
    const name = currentNames.get(columnId) ?? recordedNames.get(columnId);
    if (name === undefined) {
      throw new Error(`${key}: a replayed column has no recorded name`);
    }
    return name;
  };
  const replayedCounts = new Map<string, number>();

  for (const { at, columnId, change } of replayColumnChanges(taskEvents, tasks)) {
    increment(hourCounts(at).columns, columnName(columnId), change);
    increment(replayedCounts, columnId, change);
  }

  const currentCounts = new Map<string, number>();
  for (const entry of tasks) {
    increment(currentCounts, entry.column_id);
  }

  for (const columnId of new Set([...replayedCounts.keys(), ...currentCounts.keys()])) {
    const replayed = replayedCounts.get(columnId) ?? 0;
    const current = currentCounts.get(columnId) ?? 0;
    if (replayed !== current) {
      throw new Error(
        `${key}: column ${columnName(columnId)} replays to ${replayed} tasks but holds ${current}`,
      );
    }
  }

  return {
    key,
    kind,
    createdAt: toInstant(projectRecord.created_at),
    columns: boardColumns.map((entry) => entry.name),
    tasks: {
      total: tasks.length,
      archived: tasks.filter((entry) => entry.archived_at !== null).length,
      byColumn: Object.fromEntries(
        boardColumns.map((entry) => [entry.name, currentCounts.get(entry.id) ?? 0]),
      ),
    },
    hours: [...hours]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([hour, counts]) => toHourRow(hour, counts))
      .filter((row) => Object.keys(row).length > 1),
  };
}

function toHourRow(hour: string, counts: HourCounts): HourRow {
  const row: HourRow = { hour };
  if (counts.tasksCreated > 0) {
    row.tasksCreated = counts.tasksCreated;
  }

  for (const field of ["actions", "actorKinds", "hosts", "models", "columns"] as const) {
    const countMap = toCountMap(counts[field]);
    if (Object.keys(countMap).length > 0) {
      row[field] = countMap;
    }
  }

  return row;
}

/** Whether task 1 of the oldest listed project still exists. */
export function readFirstTask(projects: Array<ProjectStats>): FirstTask {
  const oldest = projects.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )[0];
  const firstTask = oldest
    ? task.getAll({ projectKey: oldest.key, archive: "all" }).find((entry) => entry.number === 1)
    : undefined;

  return firstTask === undefined
    ? { present: false }
    : { present: true, createdAt: toInstant(firstTask.created_at) };
}

/** The figures of every listed project, read through core. The store must already be selected. */
export function summarizeProjects(projects: ReadonlyArray<StatsProject>) {
  const projectStats = projects.map(summarizeProject);
  return { firstTask: readFirstTask(projectStats), projects: projectStats };
}

/** Runs both integrity pragmas on a database file through a read-only connection. */
function checkDatabase(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    const integrityRows = database
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .all();
    const foreignKeyRows = database.query("PRAGMA foreign_key_check").all();
    return {
      integrityCheck: integrityRows.map((row) => row.integrity_check).join("\n"),
      foreignKeyViolations: foreignKeyRows.length,
    };
  } finally {
    database.close();
  }
}

/** Reads a backup's figures from a temporary copy, which is removed afterwards. */
export function exportStats(backupFile: string, backupsFolder = dirname(backupFile)) {
  const takenAt = readBackupTime(basename(backupFile));
  if (readOutputFileName(backupFile, BACKUP_EXTENSION) === null || takenAt === null) {
    throw new Error(
      `${backupFile} is not named like a Zinn backup, such as 2026-09-29T12-30-05Z-cli-0.32.0-b38178c0.sqlite`,
    );
  }

  const backups = summarizeBackups(readdirSync(backupsFolder));
  const storeDirectory = mkdtempSync(join(tmpdir(), "zinn-stats-export-"));

  try {
    const databasePath = join(storeDirectory, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    copyFileSync(backupFile, databasePath, constants.COPYFILE_EXCL);

    const { database } = info.get({
      cwd: storeDirectory,
      env: { ZINN_DIR: storeDirectory },
      home: storeDirectory,
    });
    if (database.state !== "current" || database.version === null) {
      throw new Error(
        `The backup is at schema version ${database.version ?? "unknown"} (${database.state}), but core expects version ${database.latestVersion}`,
      );
    }

    const checks = checkDatabase(databasePath);
    if (checks.integrityCheck !== SOUND_INTEGRITY_CHECK || checks.foreignKeyViolations > 0) {
      throw new Error(
        `The backup failed its checks: integrity_check returned ${checks.integrityCheck} and foreign_key_check ${checks.foreignKeyViolations} rows`,
      );
    }

    process.env.ZINN_DIR = storeDirectory;
    const schemaVersion = database.version;
    const { firstTask, projects } = summarizeProjects(STATS_PROJECTS);

    return {
      format: STATS_FORMAT,
      snapshot: {
        takenAt,
        schemaVersion,
        migrationsApplied: MIGRATIONS.filter((migration) => migration.version <= schemaVersion)
          .length,
        integrityCheck: checks.integrityCheck,
        foreignKeyViolations: checks.foreignKeyViolations,
      },
      backups,
      firstTask,
      projects,
    };
  } finally {
    rmSync(storeDirectory, { recursive: true, force: true });
  }
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { backups: { type: "string" } },
  });
  if (positionals.length !== 1) {
    throw new Error("Usage: bun scripts/stats-export.ts <backup-file> [--backups <folder>]");
  }

  const stats = `${JSON.stringify(exportStats(positionals[0]!, values.backups), null, "\t")}\n`;
  if (existsSync(STATS_PATH) && readFileSync(STATS_PATH, "utf8") === stats) {
    console.log(`${STATS_PATH} is up to date.`);
    return;
  }

  writeFileSync(STATS_PATH, stats);
  console.log(`Wrote ${STATS_PATH}.`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
