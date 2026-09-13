// https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html
type BoundProperty<P extends string> = `$${P}`;
// https://www.typescriptlang.org/docs/handbook/2/mapped-types.html
export type Bind<T, K extends string & keyof T = string & keyof T> = {
  [Property in BoundProperty<K>]: T[keyof T];
};

export type Project = {
  id: string;
  key: string;
  name: string;
  task_count: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

export type TaskMoveDirection = "top" | "up" | "down" | "bottom";
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

export type Column = {
  id: string;
  project_id: string;
  name: string;
  column_order: string;
};
