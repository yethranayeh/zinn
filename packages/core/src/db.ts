import { Database } from "bun:sqlite";
import { DB_PATH } from "./constant";

export const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL;");
// TODO: https://bun.com/docs/runtime/sqlite#wal-sidecar-file-cleanup macOS does not auto cleanup
