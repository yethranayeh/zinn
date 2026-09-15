// https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html
type BoundProperty<P extends string> = `$${P}`;
// https://www.typescriptlang.org/docs/handbook/2/mapped-types.html
export type Bind<T, K extends string & keyof T = string & keyof T> = {
  [Property in BoundProperty<K>]: T[keyof T];
};

export type WithId<T extends { id: string }> = Pick<T, "id"> & Partial<Omit<T, "id">>;

export type Project = {
  id: string;
  key: string;
  name: string;
  task_count: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

export type Task = {
  id: string;
  project_id: string;
  column_id: string;
  number: number;
  title: string;
  description: string | null;
  task_order: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

export type TaskRelationType = "related" | "dependency" | "duplicate";
export type TaskRelation = {
  id: string;
  source_task_id: string;
  target_task_id: string;
  relation_type: TaskRelationType;
  created_at: number;
};

export type Column = {
  id: string;
  project_id: string;
  name: string;
  column_order: string;
};
