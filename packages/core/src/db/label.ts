import type { Bind, Label } from "../types";

import { randomUUIDv7 } from "bun";

import { DB_TABLE } from "../constant";
import { getDb } from "../db";

export function getAll() {
  const db = getDb();
  return db.query<Label, []>(`SELECT * FROM ${DB_TABLE.label} ORDER BY name`).all();
}

export function getById(labelId: string) {
  const db = getDb();

  return db
    .query<Label, Bind<{ labelId: string }>>(`SELECT * FROM ${DB_TABLE.label}
    WHERE id = $labelId`)
    .get({ $labelId: labelId });
}

export function getByName(name: string) {
  const db = getDb();

  return db
    .query<Label, Bind<{ name: string }>>(`SELECT * FROM ${DB_TABLE.label}
    WHERE name = $name`)
    .get({ $name: name });
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

export function deleteById(id: string) {
  const db = getDb();

  return db
    .query<never, Bind<Pick<Label, "id">>>(`DELETE FROM ${DB_TABLE.label} WHERE id = $id;`)
    .run({ $id: id });
}
