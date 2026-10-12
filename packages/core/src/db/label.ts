import type { Bind, Label } from "../types.js";

import { v7 as uuidv7 } from "uuid";

import { DB_TABLE } from "../constant.js";
import { getDb } from "../db.js";
import { compareNames } from "../lib.js";

export function getAll() {
  const db = getDb();
  return db.query<Label, []>(`SELECT * FROM ${DB_TABLE.label}`).all().sort(compareNames);
}

export function getById(labelId: string) {
  const db = getDb();

  return db
    .query<Label, Bind<{ labelId: string }>>(`SELECT * FROM ${DB_TABLE.label}
    WHERE id = $labelId`)
    .get({ $labelId: labelId });
}

export function create(props: Omit<Label, "id">) {
  const db = getDb();

  const query = db.query<Label, Bind<Label>>(`INSERT INTO
    ${DB_TABLE.label} (id, name, description, color)
    VALUES              ($id, $name, $description, $color)
    RETURNING *;`);

  return query.get({
    $id: uuidv7(),
    $name: props.name,
    $description: props.description,
    $color: props.color,
  });
}

export function update(props: Label) {
  return getDb()
    .query<Label, Bind<Label>>(`UPDATE ${DB_TABLE.label}
    SET name = $name, description = $description, color = $color
    WHERE id = $id
    RETURNING *;`)
    .get({
      $id: props.id,
      $name: props.name,
      $description: props.description,
      $color: props.color,
    });
}

export function deleteById(id: string) {
  const db = getDb();

  db.query<never, Bind<Pick<Label, "id">>>(`DELETE FROM ${DB_TABLE.label} WHERE id = $id;`).run({
    $id: id,
  });
}
