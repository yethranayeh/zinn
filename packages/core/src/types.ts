import type { LabelColor } from "./schemas/label.js";
import type { TaskPriority } from "./schemas/task.js";
import type { ActorKind } from "./schemas/actor.js";
import type { RelationCreateInput } from "./schemas/relation.js";

export type { LabelColor } from "./schemas/label.js";
export type { TaskPriority } from "./schemas/task.js";
export type { Actor, ActorKind } from "./schemas/actor.js";

// https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html
type BoundProperty<P extends string> = `$${P}`;
// https://www.typescriptlang.org/docs/handbook/2/mapped-types.html
export type Bind<T, K extends string & keyof T = string & keyof T> = {
  [Property in K as BoundProperty<Property>]: T[Property];
};

export type WithId<T extends { id: string }> = Pick<T, "id"> & Partial<Omit<T, "id">>;

export type Project = {
  id: string;
  key: string;
  name: string;
  description: string | null;
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
  priority: TaskPriority | null;
  comment_count: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

export type TaskWithKey = Task & { key: string };

export type TaskChange ={ task: TaskWithKey; changed: boolean };

export type TaskRelationType = RelationCreateInput["relation_type"];
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

export type Label = {
  id: string;
  name: string;
  description: string | null;
  color: LabelColor;
};

export type Comment = {
  id: string;
  task_id: string;
  number: number;
  text: string;
  created_at: number;
  updated_at: number;
};

export type CommentWithKey = Comment & { key: string };

export type ActivityAction =
  | "create"
  | "edit"
  | "move"
  | "order"
  | "archive"
  | "unarchive"
  | "delete"
  | "relation_create"
  | "relation_delete"
  | "comment_create"
  | "comment_edit"
  | "comment_delete";

export type ActivityEntityType = "task" | "project" | "column" | "label";

export type Activity = {
  id: string;
  created_at: number;
  actor_name: string;
  actor_email: string | null;
  actor_kind: ActorKind;
  entity_type: ActivityEntityType;
  entity_id: string;
  action: ActivityAction;
  changes: Record<string, unknown> | null;
};
