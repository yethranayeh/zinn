import type { SqlitePrimaryCode } from "@zinn-dev/core";

import { z } from "zod";
import {
  CoreError,
  ReadOnlyDatabaseError,
  SqliteError,
  TextEditMatchError,
  UnmarkedDatabaseError,
  isSqliteErrorFamily,
} from "@zinn-dev/core";

export const errorCodeSchema = z.enum([
  "invalid_input",
  "not_found",
  "conflict",
  "storage",
  "internal",
]);

export const errorDetailsSchema = z.strictObject({
  argument: z.string().optional(),
  field: z.array(z.union([z.string(), z.number()])).optional(),
  entity: z
    .enum([
      "project",
      "task",
      "comment",
      "label",
      "column",
      "relation",
      "activity",
      "database",
      "backup",
    ])
    .optional(),
  key: z.string().optional(),
  source: z.enum(["explicit", "defaultProject"]).optional(),
  settingsPath: z.string().optional(),
  reason: z
    .enum([
      "dash_value",
      "unknown_option",
      "unknown_command",
      "missing_command",
      "missing_argument",
      "unexpected_argument",
      "unquoted_column",
      "confirmation_required",
      "invalid_json",
      "invalid_settings",
      "invalid_storage",
      "already_exists",
      "archived",
      "parent_exists",
      "relation_changed",
      "cycle",
      "different_project",
      "different_column",
      "ambiguous_reference",
      "invalid_cursor",
      "cursor_version",
      "different_sort",
      "task_id_cursor",
      "text_match_count",
      "no_columns",
      "has_tasks",
      "unmarked_database",
      "newer_database",
      "older_database",
      "invalid_backup",
      "busy",
      "locked",
      "permission_denied",
      "read_only",
      "disk_full",
      "corrupt",
      "not_database",
      "missing_index",
      "io",
    ])
    .optional(),
  matchCount: z.number().int().nonnegative().optional(),
  candidateIds: z.array(z.string()).optional(),
  path: z.string().optional(),
  databasePath: z.string().optional(),
  backupDirectory: z.string().optional(),
  backupPath: z.string().optional(),
  schemaVersion: z.number().int().nonnegative().optional(),
  supportedSchemaVersion: z.number().int().nonnegative().optional(),
  cause: z
    .strictObject({
      code: z.string().optional(),
      errcode: z.number().int().optional(),
      message: z.string(),
    })
    .optional(),
});

export const errorDocumentSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    help: z.string().optional(),
    details: errorDetailsSchema.optional(),
    diagnostics: z.array(z.string()).optional(),
  }),
});

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ErrorDetails = z.infer<typeof errorDetailsSchema>;
export type CliFailure = z.infer<typeof errorDocumentSchema>["error"];
type ClassifiedFailure = Omit<CliFailure, "message"> & { suggestedRoute?: Array<string> };

/** A CLI failure with public facts and an internal recovery route. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = "invalid_input",
    readonly details?: ErrorDetails,
    public help?: string,
    readonly suggestedRoute?: Array<string>,
  ) {
    super(message);
    this.name = "CliError";
  }
}

const taskCursorRecovery: Partial<Record<NonNullable<ErrorDetails["reason"]>, string>> = {
  invalid_cursor:
    ". Copy the cursor from the continuation command that zinn task list prints, or list again without --starting-after.",
  cursor_version: ". Run zinn task list again without --starting-after to get a current cursor.",
  different_sort:
    ". Keep the --sort of the zinn task list command that printed the cursor, or start again without --starting-after.",
  task_id_cursor:
    ". When more tasks remain, zinn task list prints a continuation command with the cursor on stderr. Run that command.",
};

/** Recovery text and its single suggested route, when one is identified. */
export function recoveryHint(
  error: unknown,
): { suffix: string; suggestedRoute?: Array<string> } | undefined {
  if (error instanceof ReadOnlyDatabaseError && error.reason === "older") {
    return { suffix: ". Run `zinn migrate` to upgrade it.", suggestedRoute: ["migrate"] };
  }

  if (error instanceof UnmarkedDatabaseError) {
    return { suffix: ". Add --allow-legacy-read to read it anyway." };
  }

  if (error instanceof TextEditMatchError && error.matchCount > 1) {
    return { suffix: " Use --all to replace every match." };
  }

  if (error instanceof CoreError && error.kind === "missing" && error.facts.entity === "database") {
    return {
      suffix: ". Create one with `zinn project create`.",
      suggestedRoute: ["project", "create"],
    };
  }

  if (error instanceof CoreError && error.facts.reason === "no_columns") {
    return {
      suffix: `. Add a column with zinn project column create ${error.facts.key} <name>.`,
      suggestedRoute: ["project", "column", "create"],
    };
  }

  if (error instanceof CoreError && error.facts.reason === "has_tasks") {
    return {
      suffix:
        ". Use zinn task move or zinn task delete to clear the column. Archived tasks must be unarchived before moving.",
    };
  }

  const cursorRecovery =
    error instanceof CoreError && error.facts.reason !== undefined
      ? taskCursorRecovery[error.facts.reason]
      : undefined;
  if (cursorRecovery !== undefined) {
    return { suffix: cursorRecovery, suggestedRoute: ["task", "list"] };
  }

  if (error instanceof Error && error.message === "no such table: task_search") {
    return {
      suffix: ". Run `zinn reindex` to rebuild the search index.",
      suggestedRoute: ["reindex"],
    };
  }

  return undefined;
}

const coreCodes = {
  input: "invalid_input",
  missing: "not_found",
  conflict: "conflict",
  storage: "storage",
} as const;
const osReasons: Record<string, ErrorDetails["reason"]> = {
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  EROFS: "read_only",
  ENOSPC: "disk_full",
  EDQUOT: "disk_full",
  EBUSY: "busy",
  EIO: "io",
  ENOENT: "io",
  ENAMETOOLONG: "io",
  ELOOP: "io",
  ENOTDIR: "io",
  EISDIR: "io",
  EMFILE: "io",
  ENFILE: "io",
  EFBIG: "io",
  ENXIO: "io",
  ENODEV: "io",
  EEXIST: "io",
};
const sqliteReasons: ReadonlyArray<
  readonly [SqlitePrimaryCode, NonNullable<ErrorDetails["reason"]>]
> = [
  ["SQLITE_BUSY", "busy"],
  ["SQLITE_LOCKED", "locked"],
  ["SQLITE_PERM", "permission_denied"],
  ["SQLITE_AUTH", "permission_denied"],
  ["SQLITE_READONLY", "read_only"],
  ["SQLITE_FULL", "disk_full"],
  ["SQLITE_CORRUPT", "corrupt"],
  ["SQLITE_NOTADB", "not_database"],
  ["SQLITE_IOERR", "io"],
  ["SQLITE_CANTOPEN", "io"],
  ["SQLITE_NOLFS", "io"],
];

/** Selects public facts explicitly
 * Error properties and submitted objects do not go to output
 */
function publicDetails(facts: ErrorDetails): ErrorDetails {
  const details: ErrorDetails = {
    argument: facts.argument,
    field: facts.field,
    entity: facts.entity,
    key: facts.key,
    source: facts.source,
    settingsPath: facts.settingsPath,
    reason: facts.reason,
    matchCount: facts.matchCount,
    candidateIds: facts.candidateIds,
    path: facts.path,
    databasePath: facts.databasePath,
    backupDirectory: facts.backupDirectory,
    backupPath: facts.backupPath,
    schemaVersion: facts.schemaVersion,
    supportedSchemaVersion: facts.supportedSchemaVersion,
  };

  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

function nativeFailure(error: Error): ErrorDetails | undefined {
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === undefined) {
    return undefined;
  }

  const reason =
    error instanceof SqliteError
      ? sqliteReasons.find(([primary]) => isSqliteErrorFamily(error, primary))?.[1]
      : osReasons[code];

  if (reason === undefined) {
    return undefined;
  }

  return {
    reason,
    ...("path" in error && typeof error.path === "string" ? { path: error.path } : {}),
    cause: {
      code,
      ...(error instanceof SqliteError ? { errcode: error.errcode } : {}),
      message: error.message,
    },
  };
}

/** Finds causes of initialization wrappers without serializing their error chains. */
export function classifyFailure(error: unknown): ClassifiedFailure {
  const suggestedRoute = recoveryHint(error)?.suggestedRoute;
  const recovery = suggestedRoute === undefined ? {} : { suggestedRoute };
  const visited = new Set<Error>();
  let current = error;
  let classified: Omit<CliFailure, "message"> | undefined;

  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);

    if (current instanceof CliError) {
      return {
        code: current.code,
        details: current.details,
        help: current.help,
        ...recovery,
        ...(current.suggestedRoute === undefined ? {} : { suggestedRoute: current.suggestedRoute }),
      };
    }

    if (current instanceof CoreError && classified === undefined) {
      const details = publicDetails(current.facts);
      if (current.kind === "missing" && current.facts.key !== undefined) {
        details.source = "explicit";
      }

      classified = { code: coreCodes[current.kind], details };
    }

    if (current instanceof z.ZodError && classified === undefined) {
      classified = {
        code: "invalid_input",
        details: {
          field: current.issues[0]?.path.map((part) =>
            typeof part === "symbol" ? String(part) : part,
          ),
        },
      };
    }

    const native = nativeFailure(current);
    if (classified?.code === "storage" && current instanceof SqliteError) {
      classified.details = {
        ...native,
        ...classified.details,
        cause: { code: current.code, errcode: current.errcode, message: current.message },
      };
      break;
    }

    if (native !== undefined) {
      if (classified === undefined) {
        return { code: "storage", details: native, ...recovery };
      }

      if (classified.code === "storage") {
        classified.details = { ...native, ...classified.details, cause: native.cause };
      }

      break;
    }

    current = current.cause;
  }
  return { ...(classified ?? { code: "internal" }), ...recovery };
}
