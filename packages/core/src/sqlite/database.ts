/**
 * Core reads and writes SQLite through the Database class below.
 * bun.ts and node.ts connect this class to one library each, and this class makes both behave the same.
 */

export type SqliteValue = string | number | bigint | Uint8Array | null;
/** Named bindings keep the placeholder's `$` prefix in their keys, as in the SQL. */
export type NamedBindings = Record<string, SqliteValue>;
export type SqliteParams = NamedBindings | Array<SqliteValue>;
/** What the wrapper passes to a driver statement: positional values, or one named-bindings object. */
export type DriverArgs = Array<SqliteValue> | [NamedBindings];

export type OpenOptions = { readonly?: boolean };

export type DriverStatement = {
  get(...args: DriverArgs): unknown;
  all(...args: DriverArgs): Array<unknown>;
  run(...args: DriverArgs): unknown;
};

export type DriverConnection = {
  prepare(sql: string): DriverStatement;
  /** Runs one or more statements without bindings. */
  exec(sql: string): void;
  readonly inTransaction: boolean;
  close(): void;
};

export type SqliteDriver = {
  connect(path: string, options: OpenOptions): DriverConnection;
  /** The extended result code of an error the driver raised for SQLite, or null for any other error. */
  resultCode(error: unknown): number | null;
};

/**
 * Every primary and extended result code SQLite lists.
 * Later SQLite releases may add extended codes; sqliteCodeName gives those their primary code's name.
 * @link https://www.sqlite.org/rescode.html
 */
const SQLITE_CODE_NAMES: Record<number, string> = {
  0: "SQLITE_OK",
  1: "SQLITE_ERROR",
  2: "SQLITE_INTERNAL",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM",
  8: "SQLITE_READONLY",
  9: "SQLITE_INTERRUPT",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  12: "SQLITE_NOTFOUND",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  15: "SQLITE_PROTOCOL",
  16: "SQLITE_EMPTY",
  17: "SQLITE_SCHEMA",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  22: "SQLITE_NOLFS",
  23: "SQLITE_AUTH",
  24: "SQLITE_FORMAT",
  25: "SQLITE_RANGE",
  26: "SQLITE_NOTADB",
  27: "SQLITE_NOTICE",
  28: "SQLITE_WARNING",
  100: "SQLITE_ROW",
  101: "SQLITE_DONE",
  256: "SQLITE_OK_LOAD_PERMANENTLY",
  257: "SQLITE_ERROR_MISSING_COLLSEQ",
  261: "SQLITE_BUSY_RECOVERY",
  262: "SQLITE_LOCKED_SHAREDCACHE",
  264: "SQLITE_READONLY_RECOVERY",
  266: "SQLITE_IOERR_READ",
  267: "SQLITE_CORRUPT_VTAB",
  270: "SQLITE_CANTOPEN_NOTEMPDIR",
  275: "SQLITE_CONSTRAINT_CHECK",
  279: "SQLITE_AUTH_USER",
  283: "SQLITE_NOTICE_RECOVER_WAL",
  284: "SQLITE_WARNING_AUTOINDEX",
  513: "SQLITE_ERROR_RETRY",
  516: "SQLITE_ABORT_ROLLBACK",
  517: "SQLITE_BUSY_SNAPSHOT",
  518: "SQLITE_LOCKED_VTAB",
  520: "SQLITE_READONLY_CANTLOCK",
  522: "SQLITE_IOERR_SHORT_READ",
  523: "SQLITE_CORRUPT_SEQUENCE",
  526: "SQLITE_CANTOPEN_ISDIR",
  531: "SQLITE_CONSTRAINT_COMMITHOOK",
  539: "SQLITE_NOTICE_RECOVER_ROLLBACK",
  769: "SQLITE_ERROR_SNAPSHOT",
  773: "SQLITE_BUSY_TIMEOUT",
  776: "SQLITE_READONLY_ROLLBACK",
  778: "SQLITE_IOERR_WRITE",
  779: "SQLITE_CORRUPT_INDEX",
  782: "SQLITE_CANTOPEN_FULLPATH",
  787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1032: "SQLITE_READONLY_DBMOVED",
  1034: "SQLITE_IOERR_FSYNC",
  1038: "SQLITE_CANTOPEN_CONVPATH",
  1043: "SQLITE_CONSTRAINT_FUNCTION",
  1288: "SQLITE_READONLY_CANTINIT",
  1290: "SQLITE_IOERR_DIR_FSYNC",
  1294: "SQLITE_CANTOPEN_DIRTYWAL",
  1299: "SQLITE_CONSTRAINT_NOTNULL",
  1544: "SQLITE_READONLY_DIRECTORY",
  1546: "SQLITE_IOERR_TRUNCATE",
  1550: "SQLITE_CANTOPEN_SYMLINK",
  1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  1802: "SQLITE_IOERR_FSTAT",
  1811: "SQLITE_CONSTRAINT_TRIGGER",
  2058: "SQLITE_IOERR_UNLOCK",
  2067: "SQLITE_CONSTRAINT_UNIQUE",
  2314: "SQLITE_IOERR_RDLOCK",
  2323: "SQLITE_CONSTRAINT_VTAB",
  2570: "SQLITE_IOERR_DELETE",
  2579: "SQLITE_CONSTRAINT_ROWID",
  2826: "SQLITE_IOERR_BLOCKED",
  2835: "SQLITE_CONSTRAINT_PINNED",
  3082: "SQLITE_IOERR_NOMEM",
  3091: "SQLITE_CONSTRAINT_DATATYPE",
  3338: "SQLITE_IOERR_ACCESS",
  3594: "SQLITE_IOERR_CHECKRESERVEDLOCK",
  3850: "SQLITE_IOERR_LOCK",
  4106: "SQLITE_IOERR_CLOSE",
  4362: "SQLITE_IOERR_DIR_CLOSE",
  4618: "SQLITE_IOERR_SHMOPEN",
  4874: "SQLITE_IOERR_SHMSIZE",
  5130: "SQLITE_IOERR_SHMLOCK",
  5386: "SQLITE_IOERR_SHMMAP",
  5642: "SQLITE_IOERR_SEEK",
  5898: "SQLITE_IOERR_DELETE_NOENT",
  6154: "SQLITE_IOERR_MMAP",
  6410: "SQLITE_IOERR_GETTEMPPATH",
  6666: "SQLITE_IOERR_CONVPATH",
  6922: "SQLITE_IOERR_VNODE",
  7178: "SQLITE_IOERR_AUTH",
  7434: "SQLITE_IOERR_BEGIN_ATOMIC",
  7690: "SQLITE_IOERR_COMMIT_ATOMIC",
  7946: "SQLITE_IOERR_ROLLBACK_ATOMIC",
  8202: "SQLITE_IOERR_DATA",
  8458: "SQLITE_IOERR_CORRUPTFS",
};

// The low 8 bits of an extended result code are its primary code:
// 517 (SQLITE_BUSY_SNAPSHOT) & 0xff is 5 (SQLITE_BUSY). https://www.sqlite.org/rescode.html#extrc
const PRIMARY_CODE_MASK = 0xff;
// SQLite's generic error, for a code this table does not know at all.
const SQLITE_ERROR = 1;

/** The symbolic name of a result code. Unlisted extended codes fall back to their primary code's name. */
export function sqliteCodeName(errcode: number) {
  return (
    SQLITE_CODE_NAMES[errcode] ??
    SQLITE_CODE_NAMES[errcode & PRIMARY_CODE_MASK] ??
    SQLITE_CODE_NAMES[SQLITE_ERROR]!
  );
}

/** A failure SQLite reported, in the same shape on both drivers. The driver's own error is the cause. */
export class SqliteError extends Error {
  /** Symbolic result code, such as "SQLITE_BUSY_SNAPSHOT". */
  readonly code: string;
  /** Numeric extended result code, such as 517. */
  readonly errcode: number;

  constructor(message: string, errcode: number, cause: unknown) {
    super(message, { cause });
    this.name = "SQLiteError";
    this.errcode = errcode;
    this.code = sqliteCodeName(errcode);
  }
}

/** Keeps a cleanup failure reachable without replacing the error that caused the cleanup. */
export function attachSuppressed(error: unknown, suppressed: unknown) {
  if (error instanceof Error) {
    Object.assign(error, { suppressed });
  }
}

function withSqliteErrors<T>(driver: SqliteDriver, action: () => T): T {
  try {
    return action();
  } catch (error) {
    const errcode = driver.resultCode(error);
    if (errcode == null) {
      throw error;
    }

    throw new SqliteError((error as Error).message, errcode, error);
  }
}

type Placeholders = { names: Set<string>; positionalCount: number };

const QUOTES = new Set(["'", "`"]);
const IDENTIFIER_CHARACTER = /[\w$\u0080-\uffff]/;
const PLACEHOLDER_NAME = /[A-Za-z0-9_]+/y;
/**
 * SQLite reads a parameter name as every identifier character: letters, digits, `_`, `$` and any
 *  non-ASCII character, plus TCL-style `::` and `(...)` suffixes after a `$` or other prefix.
 * The scanner reads only letters, digits and `_`, so a name followed by any of these would be
 *  recorded shorter than SQLite reads it.
 * @link https://github.com/sqlite/sqlite/blob/master/src/tokenize.c (sqlite3GetToken, CC_DOLLAR)
 */
const NAME_CONTINUATION = /[$\u0080-\uffff(]|::/y;
const DIGIT = /[0-9]/;

function skipPast(sql: string, from: number, terminator: string) {
  const end = sql.indexOf(terminator, from);
  return end === -1 ? sql.length : end + terminator.length;
}

function skipQuoted(sql: string, start: number) {
  const quote = sql[start]!;
  let index = start + 1;

  while (index < sql.length) {
    if (sql[index] !== quote) {
      index++;
      continue;
    }

    // A doubled quote is an escaped quote inside the literal or identifier.
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }

    return index + 1;
  }

  return sql.length;
}

/**
 * Reads `$name` and `?` placeholders, skipping string literals, quoted identifiers and comments.
 * Throws on SQL whose parameters it cannot read exactly as SQLite does, and on double quotes.
 */
export function scanPlaceholders(sql: string): Placeholders {
  const names = new Set<string>();
  let positionalCount = 0;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];

    // Bun's SQLite accepts a double-quoted name that matches no column as a string literal,
    //  so a misspelled column or an index on "nope" succeeds silently. Node's SQLite refuses it.
    // Refusing every double quote here makes both runtimes strict.
    // https://www.sqlite.org/quirks.html#dblquote
    if (character === '"') {
      throw new TypeError(
        `Double quotes are not supported in SQL: use single quotes for strings, and [name] or backticks for an identifier that needs quoting: ${sql}`,
      );
    }

    if (QUOTES.has(character)) {
      index = skipQuoted(sql, index);
      continue;
    }

    if (character === "[") {
      index = skipPast(sql, index + 1, "]");
      continue;
    }

    if (character === "-" && next === "-") {
      index = skipPast(sql, index + 2, "\n");
      continue;
    }

    if (character === "/" && next === "*") {
      index = skipPast(sql, index + 2, "*/");
      continue;
    }

    if (character === "?") {
      if (next != null && DIGIT.test(next)) {
        throw new TypeError(`Numbered SQL parameters (?NNN) are not supported: ${sql}`);
      }

      positionalCount++;
      index++;
      continue;
    }

    const isNamedPrefix = character === "$" || character === ":" || character === "@";
    const previous = sql[index - 1];
    const continuesIdentifier = previous != null && IDENTIFIER_CHARACTER.test(previous);

    if (isNamedPrefix && !continuesIdentifier) {
      PLACEHOLDER_NAME.lastIndex = index + 1;
      const name = PLACEHOLDER_NAME.exec(sql)?.[0];

      NAME_CONTINUATION.lastIndex = index + 1 + (name?.length ?? 0);

      if (NAME_CONTINUATION.test(sql)) {
        throw new TypeError(
          `SQL parameter names may only use letters, digits and _: ${sql.slice(index, NAME_CONTINUATION.lastIndex)} in ${sql}`,
        );
      }

      if (name != null) {
        if (character !== "$") {
          throw new TypeError(`Only $name SQL parameters are supported, not ${character}${name}`);
        }

        names.add(`$${name}`);
        index += name.length + 1;
        continue;
      }
    }

    index++;
  }

  return { names, positionalCount };
}

export function isNamedBindings(value: unknown): value is NamedBindings {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

/** Both runtimes store NaN as NULL and Infinity as a REAL that reads back as text 'Inf'. */
function isNonFiniteNumber(value: unknown) {
  return typeof value === "number" && !Number.isFinite(value);
}

/**
 * Binding is strict on both drivers. Every named placeholder needs a value, no other names are
 *  accepted, `undefined`, NaN and Infinity are never bound (`null` is), and positional counts must match.
 * These errors carry no SQLite code, so nothing treats them as retriable SQLite failures.
 */
function bind(placeholders: Placeholders, params: Array<unknown>): DriverArgs {
  const named = params.length === 1 && isNamedBindings(params[0]) ? params[0] : null;

  if (named == null) {
    if (placeholders.names.size > 0) {
      throw new TypeError(`Missing SQL parameters: ${[...placeholders.names].join(", ")}`);
    }

    if (params.length !== placeholders.positionalCount) {
      throw new TypeError(
        `Expected ${placeholders.positionalCount} SQL parameters, received ${params.length}`,
      );
    }

    if (params.includes(undefined)) {
      throw new TypeError("SQL parameters cannot be undefined; use null for NULL");
    }

    const nonFinite = params.find(isNonFiniteNumber);
    if (nonFinite !== undefined) {
      throw new TypeError(`SQL parameters cannot be ${nonFinite}; SQLite cannot store it`);
    }

    return params as Array<SqliteValue>;
  }

  if (placeholders.positionalCount > 0) {
    throw new TypeError(
      `Expected ${placeholders.positionalCount} positional SQL parameters, received named parameters`,
    );
  }

  for (const name of placeholders.names) {
    if (!(name in named)) {
      throw new TypeError(`Missing SQL parameter ${name}`);
    }
  }

  for (const [name, value] of Object.entries(named)) {
    if (!placeholders.names.has(name)) {
      throw new TypeError(`Unknown SQL parameter ${name}`);
    }

    if (value === undefined) {
      throw new TypeError(`SQL parameter ${name} is undefined; use null for NULL`);
    }

    if (isNonFiniteNumber(value)) {
      throw new TypeError(`SQL parameter ${name} is ${value}; SQLite cannot store it`);
    }
  }

  return [named];
}

export class Statement<Row, Params extends Array<unknown>> {
  private readonly driver: SqliteDriver;
  private readonly statement: DriverStatement;
  private readonly placeholders: Placeholders;
  private readonly assertUsable: () => void;

  constructor(
    driver: SqliteDriver,
    connection: DriverConnection,
    sql: string,
    assertUsable: () => void,
  ) {
    this.driver = driver;
    this.assertUsable = assertUsable;
    this.placeholders = scanPlaceholders(sql);
    this.statement = withSqliteErrors(driver, () => connection.prepare(sql));
  }

  /** The first row, or null when there is none. */
  get(...params: Params): Row | null {
    this.assertUsable();
    const args = bind(this.placeholders, params);
    const row = withSqliteErrors(this.driver, () => this.statement.get(...args));
    return (row ?? null) as Row | null;
  }

  all(...params: Params): Array<Row> {
    this.assertUsable();
    const args = bind(this.placeholders, params);
    return withSqliteErrors(this.driver, () => this.statement.all(...args)) as Array<Row>;
  }

  run(...params: Params): void {
    this.assertUsable();
    const args = bind(this.placeholders, params);
    withSqliteErrors(this.driver, () => this.statement.run(...args));
  }
}

type StatementParams<Params> = Params extends Array<unknown> ? Params : [Params];

/**
 * One name for every nested transaction
 * SQLite stacks savepoints, and `ROLLBACK TO` and `RELEASE` act on the most recent one with the name.
 * @link https://www.sqlite.org/lang_savepoint.html
 */
const NESTED_TRANSACTION_SAVEPOINT = "zinn_nested_transaction";

export class Database {
  private readonly driver: SqliteDriver;
  private readonly connection: DriverConnection;
  private readonly statements = new Map<string, Statement<unknown, Array<unknown>>>();
  private isClosed = false;
  /** How many transaction() calls are running, the outermost included. */
  private transactionDepth = 0;

  constructor(driver: SqliteDriver, connection: DriverConnection) {
    this.driver = driver;
    this.connection = connection;
  }

  /** Each driver throws its own error after close; this one is the same on both. */
  private assertOpen() {
    if (this.isClosed) {
      throw new Error("The database is closed");
    }
  }

  /**
   * Some errors, such as SQLITE_FULL, make SQLite roll back the whole transaction by itself.
   * A callback that catches such an error and goes on would run its next statements outside
   *  any transaction, each committing on its own.
   * So until the transaction() call that lost its transaction returns, every statement throws.
   * @link https://www.sqlite.org/lang_transaction.html#response_to_errors_within_a_transaction
   */
  private readonly assertUsable = () => {
    this.assertOpen();

    const isTransactionLost = this.transactionDepth > 0 && !this.connection.inTransaction;
    if (isTransactionLost) {
      throw new Error(
        "SQLite rolled back this transaction after an earlier error, so no more statements can run in it",
      );
    }
  };

  /** Prepares a statement once per SQL string and reuses it afterwards. */
  query<Row = unknown, Params extends SqliteParams = SqliteParams>(
    sql: string,
  ): Statement<Row, StatementParams<Params>> {
    this.assertUsable();
    let statement = this.statements.get(sql);

    if (statement == null) {
      statement = new Statement(this.driver, this.connection, sql, this.assertUsable);
      this.statements.set(sql, statement);
    }

    return statement as Statement<Row, StatementParams<Params>>;
  }

  /** Runs one or more statements without bindings, such as PRAGMA, BEGIN, COMMIT and ROLLBACK. */
  exec(sql: string) {
    this.assertUsable();
    withSqliteErrors(this.driver, () => this.connection.exec(sql));
  }

  /** Whether the connection is inside a transaction, as SQLite reports it. */
  get inTransaction() {
    this.assertOpen();
    return this.connection.inTransaction;
  }

  /** Closing an already closed database does nothing, as in bun:sqlite; node:sqlite would throw. */
  close() {
    if (this.isClosed) {
      return;
    }

    this.statements.clear();
    withSqliteErrors(this.driver, () => this.connection.close());
    this.isClosed = true;
  }

  /**
   * `transaction(fn).immediate()` runs fn inside BEGIN IMMEDIATE and commits.
   * Inside another transaction it runs in a savepoint instead.
   * If fn or COMMIT fails, an open transaction is rolled back and the original error is rethrown.
   * If SQLite rolled the transaction back by itself, statements throw until this call returns.
   */
  transaction<T>(fn: () => T) {
    return { immediate: () => this.runTransaction(fn) };
  }

  private runTransaction<T>(fn: () => T): T {
    const isNested = this.inTransaction;
    this.exec(isNested ? `SAVEPOINT ${NESTED_TRANSACTION_SAVEPOINT}` : "BEGIN IMMEDIATE");
    this.transactionDepth++;

    try {
      const result = fn();
      this.exec(isNested ? `RELEASE ${NESTED_TRANSACTION_SAVEPOINT}` : "COMMIT");
      return result;
    } catch (error) {
      /**
       * SQLite rolls some failures back by itself,
       *  while a failed COMMIT leaves the transaction open.
       * @link https://www.sqlite.org/lang_transaction.html
       */
      if (this.inTransaction) {
        try {
          this.exec(
            isNested
              ? `ROLLBACK TO ${NESTED_TRANSACTION_SAVEPOINT}; RELEASE ${NESTED_TRANSACTION_SAVEPOINT}`
              : "ROLLBACK",
          );
        } catch (rollbackError) {
          attachSuppressed(error, rollbackError);
        }
      }

      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
}

/**
 * Opens a connection without setting pragmas or creating tables.
 * Foreign keys start off and busy_timeout at 0, as in SQLite.
 * A read-write open creates a missing database file.
 */
export function openWith(driver: SqliteDriver, path: string, options: OpenOptions = {}) {
  const connection = withSqliteErrors(driver, () => driver.connect(path, options));
  return new Database(driver, connection);
}
