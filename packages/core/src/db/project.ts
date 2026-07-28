import type { Bind, Project } from "../types";

import { DB_TABLE } from "../constant";
import { getDb } from "../db";
import { standardizeProjectKey } from "../lib";

export function getByKey(key: string) {
  const db = getDb();
  const standardizedKey = standardizeProjectKey(key);

  return db
    .query<Project, Bind<{ key: string }>>(`SELECT * FROM ${DB_TABLE.project} WHERE key = $key`)
    .get({ $key: standardizedKey });
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
