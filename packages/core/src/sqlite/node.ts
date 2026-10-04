import type { SQLInputValue } from "node:sqlite";
import type { DriverArgs, OpenOptions, SqliteDriver, SqliteValue } from "./database.ts";

import { DatabaseSync } from "node:sqlite";
import { isNamedBindings, openWith } from "./database.ts";

/**
 * bun:sqlite binds an integral number as INTEGER while it fits in a signed 52-bit integer and is not -0,
 *  and as REAL otherwise. node:sqlite binds every number as REAL, which stores 5 as '5.0' in text and JSON.
 * Passing the numbers Bun binds as INTEGER as bigint makes node:sqlite bind them as INTEGER too.
 * @link https://bun.com/docs/runtime/sqlite#integers
 */
const BUN_INTEGER_LIMIT = 2 ** 51;

function nodeValue(value: SqliteValue) {
  const isBunInteger =
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Object.is(value, -0) &&
    value >= -BUN_INTEGER_LIMIT &&
    value < BUN_INTEGER_LIMIT;

  return isBunInteger ? BigInt(value) : value;
}

// node:sqlite takes named bindings as one object in place of the positional values.
function nodeArgs(args: DriverArgs) {
  const [first] = args;

  if (args.length === 1 && isNamedBindings(first)) {
    const named = Object.entries(first).map(([name, value]) => [name, nodeValue(value)]);
    return [Object.fromEntries(named)] as Array<SQLInputValue>;
  }

  return (args as Array<SqliteValue>).map(nodeValue) as Array<SQLInputValue>;
}

// node:sqlite returns rows with a null prototype; core works with ordinary objects.
function toPlainRow(row: object | undefined) {
  return row == null ? null : { ...row };
}

export const driver: SqliteDriver = {
  connect(path, options) {
    // node:sqlite turns foreign keys on by default; start from SQLite's default like bun:sqlite.
    const db = new DatabaseSync(path, {
      readOnly: options.readonly ?? false,
      enableForeignKeyConstraints: false,
    });

    return {
      prepare(sql) {
        const statement = db.prepare(sql);
        statement.setReadBigInts(true);

        return {
          get: (...args) => toPlainRow(statement.get(...nodeArgs(args))),
          all: (...args) => statement.all(...nodeArgs(args)).map((row) => toPlainRow(row)),
          run: (...args) => statement.run(...nodeArgs(args)),
        };
      },
      exec: (sql) => db.exec(sql),
      get inTransaction() {
        return db.isTransaction;
      },
      close: () => db.close(),
    };
  },
  resultCode(error) {
    const isSqliteError =
      error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR";

    if (isSqliteError && "errcode" in error && typeof error.errcode === "number") {
      return error.errcode;
    }

    return null;
  },
};

export function openDatabase(path: string, options?: OpenOptions) {
  return openWith(driver, path, options);
}
