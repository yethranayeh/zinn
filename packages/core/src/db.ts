import { Database } from "bun:sqlite";
import { DB_PATH } from "./constant";

export const db = new Database(DB_PATH, { create: true });
