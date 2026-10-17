import { z } from "zod";
import { CoreError, SqliteError } from "@zinn-dev/core";

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
      "confirmation_required",
      "invalid_json",
      "invalid_settings",
      "invalid_storage",
      "already_exists",
      "archived",
      "parent_exists",
      "cycle",
      "different_project",
      "different_column",
      "ambiguous_reference",
      "text_match_count",
      "no_columns",
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

/** A failure detected by the CLI, with only facts intended for its public output. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = "invalid_input",
    readonly details?: ErrorDetails,
    public help?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
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
  ENOTDIR: "io",
  EISDIR: "io",
  EMFILE: "io",
  ENFILE: "io",
  EFBIG: "io",
  ENXIO: "io",
  ENODEV: "io",
  EEXIST: "io",
};
const sqliteReasons: Record<string, ErrorDetails["reason"]> = {
  SQLITE_BUSY: "busy",
  SQLITE_LOCKED: "locked",
  SQLITE_PERM: "permission_denied",
  SQLITE_AUTH: "permission_denied",
  SQLITE_READONLY: "read_only",
  SQLITE_FULL: "disk_full",
  SQLITE_CORRUPT: "corrupt",
  SQLITE_NOTADB: "not_database",
  SQLITE_IOERR: "io",
  SQLITE_CANTOPEN: "io",
  SQLITE_NOLFS: "io",
};

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
      ? Object.entries(sqliteReasons).find(
          ([primary]) => code === primary || code.startsWith(`${primary}_`),
        )?.[1]
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
export function classifyFailure(error: unknown): Omit<CliFailure, "message"> {
  const visited = new Set<Error>();
  let current = error;
  let classified: Omit<CliFailure, "message"> | undefined;

  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);

    if (current instanceof CliError) {
      return { code: current.code, details: current.details, help: current.help };
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
        return { code: "storage", details: native };
      }

      if (classified.code === "storage") {
        classified.details = { ...native, ...classified.details, cause: native.cause };
      }

      break;
    }

    current = current.cause;
  }
  return classified ?? { code: "internal" };
}
