/** Facts about an expected failure, independent of a client's output format. */
export type FailureKind = "input" | "missing" | "conflict" | "storage";

export type FailureFacts = {
  entity?:
    | "project"
    | "task"
    | "comment"
    | "label"
    | "column"
    | "relation"
    | "activity"
    | "database"
    | "backup";
  key?: string;
  field?: Array<string | number>;
  reason?:
    | "invalid_json"
    | "invalid_settings"
    | "already_exists"
    | "archived"
    | "parent_exists"
    | "cycle"
    | "different_project"
    | "different_column"
    | "ambiguous_reference"
    | "text_match_count"
    | "no_columns"
    | "unmarked_database"
    | "newer_database"
    | "older_database"
    | "invalid_backup"
    | "busy"
    | "disk_full"
    | "corrupt"
    | "not_database"
    | "missing_index";
  matchCount?: number;
  candidateIds?: Array<string>;
  settingsPath?: string;
  path?: string;
  databasePath?: string;
  backupPath?: string;
  schemaVersion?: number;
  supportedSchemaVersion?: number;
};

export class CoreError extends Error {
  override name = "CoreError";

  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly facts: FailureFacts = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ValidationIssue = { code: string; path: Array<string | number>; message: string };

/** Keeps schema issue locations without retaining the submitted object. */
export class InputValidationError extends CoreError {
  override name = "InputValidationError";
  readonly issues: Array<ValidationIssue>;

  constructor(
    issues: ReadonlyArray<{ code: string; path: ReadonlyArray<PropertyKey>; message: string }>,
  ) {
    const safeIssues = issues.map(({ code, path, message }) => ({
      code,
      path: path.map((part) => (typeof part === "symbol" ? String(part) : part)),
      message,
    }));
    super(safeIssues.map((issue) => issue.message).join("\n"), "input", {
      field: safeIssues[0]?.path,
    });
    this.issues = safeIssues;
  }
}
