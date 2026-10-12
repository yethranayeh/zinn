import type { Bind, Comment } from "../types.js";

import { v7 as uuidv7 } from "uuid";

import { DB_TABLE } from "../constant.js";
import { getDb } from "../db.js";

export function getByTaskIdAndNumber(taskId: string, number: number) {
  const db = getDb();

  return db
    .query<Comment, Bind<Pick<Comment, "task_id" | "number">>>(`SELECT *
    FROM ${DB_TABLE.comment}
    WHERE task_id = $task_id AND number = $number`)
    .get({ $task_id: taskId, $number: number });
}

export function getAllByTaskId(taskId: string) {
  const db = getDb();

  return db
    .query<Comment, Bind<{ taskId: string }>>(`SELECT * FROM ${DB_TABLE.comment}
    WHERE task_id = $taskId
    ORDER BY number;`)
    .all({ $taskId: taskId });
}

export function create(props: Pick<Comment, "task_id" | "number" | "text">) {
  const db = getDb();

  const query = db.query<Comment, Bind<Comment>>(`INSERT INTO
    ${DB_TABLE.comment} (id, task_id, number, text, created_at, updated_at)
    VALUES              ($id, $task_id, $number, $text, $created_at, $updated_at)
    RETURNING *;`);

  const now = Date.now();

  return query.get({
    $id: uuidv7(),
    $task_id: props.task_id,
    $number: props.number,
    $text: props.text,
    $created_at: now,
    $updated_at: now,
  });
}

export function update(props: Pick<Comment, "id" | "text" | "updated_at">) {
  return getDb()
    .query<Comment, Bind<typeof props>>(`UPDATE ${DB_TABLE.comment}
    SET text = $text, updated_at = $updated_at
    WHERE id = $id
    RETURNING *;`)
    .get({ $id: props.id, $text: props.text, $updated_at: props.updated_at });
}

export function deleteById(id: string) {
  const db = getDb();

  db.query<never, Bind<Pick<Comment, "id">>>(`DELETE FROM ${DB_TABLE.comment} WHERE id = $id;`).run(
    { $id: id },
  );
}
