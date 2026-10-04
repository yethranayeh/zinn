import type { Bind, Column } from "../types";

import { DB_TABLE } from "../constant";
import { getDb } from "../db";

export function getById(id: string) {
  const db = getDb();
  return db
    .query<Column, Bind<Pick<Column, "id">>>(`SELECT * FROM ${DB_TABLE.projectColumn}
    WHERE id = $id`)
    .get({ $id: id });
}

export function getAllByProjectId(projectId: string) {
  const db = getDb();
  return db
    .query<Column, Bind<Pick<Column, "project_id">>>(`SELECT * FROM ${DB_TABLE.projectColumn}
    WHERE project_id = $project_id
    ORDER BY column_order`)
    .all({ $project_id: projectId });
}

export function create(column: Column) {
  const db = getDb();
  const query = db.query<Column, Bind<Column>>(`INSERT INTO
    ${DB_TABLE.projectColumn} (id, project_id, name, column_order)
    VALUES                    ($id, $project_id, $name, $column_order)
    RETURNING *;`);

  return query.get({
    $id: column.id,
    $project_id: column.project_id,
    $name: column.name,
    $column_order: column.column_order,
  });
}

export function update(props: Pick<Column, "id" | "name">) {
  return getDb()
    .query<Column, Bind<typeof props>>(`UPDATE ${DB_TABLE.projectColumn}
    SET name = $name
    WHERE id = $id
    RETURNING *;`)
    .get({ $id: props.id, $name: props.name });
}

export function updateOrder(props: Pick<Column, "id" | "column_order">) {
  return getDb()
    .query<Column, Bind<typeof props>>(`UPDATE ${DB_TABLE.projectColumn}
    SET column_order = $column_order
    WHERE id = $id
    RETURNING *;`)
    .get({ $id: props.id, $column_order: props.column_order });
}
