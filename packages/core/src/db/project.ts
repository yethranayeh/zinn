import type { Bind, Project } from "../types";

import { randomUUIDv7 } from "bun";

import { DB_TABLE } from "../constant";
import { getDb } from "../db";
import { standardizeProjectKey } from "../lib";

export function getById(id: string) {
  const db = getDb();

  return db
    .query<Project, Bind<{ id: string }>>(`SELECT * FROM ${DB_TABLE.project} WHERE id = $id`)
    .get({ $id: id });
}

export function getByKey(key: string) {
  const db = getDb();
  const standardizedKey = standardizeProjectKey(key);

  return db
    .query<Project, Bind<{ key: string }>>(`SELECT * FROM ${DB_TABLE.project} WHERE key = $key`)
    .get({ $key: standardizedKey });
}

export function create({ key, name }: { key: string; name: string }) {
  const db = getDb();

  const query = db.query<
    Project,
    Bind<Pick<Project, "id" | "key" | "name" | "created_at" | "updated_at">>
  >(`INSERT INTO
    ${DB_TABLE.project} (id, key, name, created_at, updated_at)
    VALUES              ($id, $key, $name, $created_at, $updated_at)
    RETURNING *;`);

  const time = Date.now();
  const standardizedKey = standardizeProjectKey(key);

  return query.get({
    $id: randomUUIDv7(),
    $key: standardizedKey,
    $name: name,
    $created_at: time,
    $updated_at: time,
  });
}

export function incrementTaskCounterById(projectId: string) {
  const db = getDb();

  const nextTaskNumber = db
    .query<Pick<Project, "task_count">, Bind<Pick<Project, "id">>>(`UPDATE ${DB_TABLE.project}
          SET task_count = task_count + 1
          WHERE id = $id RETURNING task_count`)
    .get({ $id: projectId });
  return nextTaskNumber;
}

// TODO: maybe allow both by `key` and `id`, and use whichever is provided
export function deleteByKey(key: string) {
  const db = getDb();

  const standardizedKey = standardizeProjectKey(key);
  return db
    .query(`DELETE FROM ${DB_TABLE.project} WHERE key = $key;`)
    .run({ $key: standardizedKey });
}
