import { z } from "zod";

export const relationTypeSchema = z.enum(["related", "dependency", "duplicate", "subtask"]);

export const relationCreateSchema = z.strictObject({
  // For dependency, the source task depends on the target task.
  // For duplicate, the source task is a duplicate of the target task.
  // For subtask, the source task is a child of the target task.
  sourceTaskKey: z.string(),
  targetTaskKey: z.string(),
  relation_type: relationTypeSchema,
});

export type RelationCreateInput = z.infer<typeof relationCreateSchema>;

export const relationDeleteSchema = relationCreateSchema;
export type RelationDeleteInput = z.infer<typeof relationDeleteSchema>;
