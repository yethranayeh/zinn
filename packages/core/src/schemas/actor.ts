import { z } from "zod";

export const actorKindSchema = z.enum(["human", "agent"]);
const actorDeclarationSchema = z.string().trim().min(1, "Actor declaration cannot be blank");

export const actorSchema = z
  .strictObject(
    {
      name: z.string().trim().min(1, "Actor name cannot be blank").nullable(),
      email: z.string().nullable(),
      kind: actorKindSchema,
      /** How the name and kind were established. */
      source: actorDeclarationSchema.nullish(),
      /** The top-level conversation, including its subagents. */
      sessionId: actorDeclarationSchema.nullish(),
      /** The execution thread that ran the command. */
      threadId: actorDeclarationSchema.nullish(),
      /** The host's agent name. */
      agent: actorDeclarationSchema.nullish(),
      /** The model this execution reports running. */
      model: actorDeclarationSchema.nullish(),
      /** The effort this execution reports. */
      effort: actorDeclarationSchema.nullish(),
    },
    { error: "An actor is required" },
  )
  .refine((actor) => actor.name !== null || actor.kind === "agent", {
    path: ["name"],
    message: "Human actors require a name",
  });

export type ActorKind = z.infer<typeof actorKindSchema>;
export type Actor = z.infer<typeof actorSchema>;
