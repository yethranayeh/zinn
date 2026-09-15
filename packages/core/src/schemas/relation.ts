import { z } from "zod";

export const relationCreateSchema = z.strictObject({
  // For dependency, the source task depends on the target task.
  sourceTaskKey: z.string(),
  targetTaskKey: z.string(),
  relation_type: z.enum(["related", "dependency", "duplicate"]),
});

export type RelationCreateInput = z.infer<typeof relationCreateSchema>;
