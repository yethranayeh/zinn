import { z } from "zod";

export const actorKindSchema = z.enum(["human", "agent"]);
export const actorSchema = z.strictObject(
  {
    name: z.string().trim().min(1, "Actor name cannot be blank"),
    email: z.string().nullable(),
    kind: actorKindSchema,
  },
  { error: "An actor is required" },
);

export type ActorKind = z.infer<typeof actorKindSchema>;
export type Actor = z.infer<typeof actorSchema>;
