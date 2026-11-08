/** The restore state file that lets a later run undo a session that died. */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const STATE_VERSION = 1;
const STATE_PATH_ENV = "QUIET_SESSION_STATE_FILE";
const APPLICATION_SUPPORT_DIRECTORY = join("Library", "Application Support", "quiet-session");
const STATE_FILE_NAME = "restore-state.json";

export type ChangeKind = "spotlight" | "time-machine" | "wifi";

export type RestoreEntry = {
  id: string;
  kind: ChangeKind;
  label: string;
  priorState: string;
  undo: Array<string>;
  undoCommand: string;
  applied?: boolean;
  appliedExitCode?: number;
};

export type RestoreState = {
  version: 1;
  sessionId: string;
  createdAt: string;
  changes: Array<RestoreEntry>;
};

/** The fixed per-user path, or an explicit path supplied for tests and recovery runs. */
export function resolveStatePath(): string {
  const override = process.env[STATE_PATH_ENV];
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }

  return join(homedir(), APPLICATION_SUPPORT_DIRECTORY, STATE_FILE_NAME);
}

export function writeRestoreState(path: string, state: RestoreState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

export function readRestoreState(path: string): RestoreState {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("restore state is not an object");
  }
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`unsupported restore state version: ${String(parsed.version)}`);
  }
  if (typeof parsed.sessionId !== "string" || typeof parsed.createdAt !== "string") {
    throw new Error("restore state is missing its session id or creation time");
  }
  if (!Array.isArray(parsed.changes)) {
    throw new Error("restore state is missing its changes");
  }
  const changes = parsed.changes.map((entry, index) => readEntry(entry, index));
  return {
    version: STATE_VERSION,
    sessionId: parsed.sessionId,
    createdAt: parsed.createdAt,
    changes,
  };
}

export function removeRestoreState(path: string): void {
  rmSync(path, { force: true });
}

function readEntry(value: unknown, index: number): RestoreEntry {
  if (!isRecord(value)) {
    throw new Error(`restore change ${index + 1} is not an object`);
  }
  const kind = value.kind;
  if (kind !== "spotlight" && kind !== "time-machine" && kind !== "wifi") {
    throw new Error(`restore change ${index + 1} has an unknown kind`);
  }
  for (const field of ["id", "label", "priorState", "undoCommand"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`restore change ${index + 1} is missing ${field}`);
    }
  }
  if (!Array.isArray(value.undo) || value.undo.length === 0) {
    throw new Error(`restore change ${index + 1} is missing its undo command`);
  }
  const undo = value.undo.map((word) => {
    if (typeof word !== "string" || word.length === 0) {
      throw new Error(`restore change ${index + 1} has an invalid undo command`);
    }
    return word;
  });
  return {
    id: value.id as string,
    kind,
    label: value.label as string,
    priorState: value.priorState as string,
    undo,
    undoCommand: value.undoCommand as string,
    applied: typeof value.applied === "boolean" ? value.applied : undefined,
    appliedExitCode: typeof value.appliedExitCode === "number" ? value.appliedExitCode : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
