import type { Bind, Label } from "../types";

import { randomUUIDv7 } from "bun";

import { DB_TABLE } from "../constant";
import { getDb } from "../db";
import { compareNames } from "../lib";

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
    $id: randomUUIDv7(),
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
