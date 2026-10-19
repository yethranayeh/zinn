import { z } from "zod";
import { commandInputSchema, inputOptionsSchema, invocation } from "./input.js";
import { commandResultSchema, resultReferenceSchema } from "./results.js";
import { commandEffectsSchema, commandConfirmationSchema } from "./types.js";

export const jsonValueSchema = z.json();

export const capabilitiesSchema = z.strictObject({
  manifestVersion: z.literal(1),
  cli: z.strictObject({ name: z.string(), version: z.string() }),
  invocation: z.strictObject({
    routerOptions: inputOptionsSchema,
    routerOptionPlacement: z.literal(invocation.routerOptionPlacement),
    optionSeparator: z.literal(invocation.optionSeparator),
    literalOptionValue: z.literal(invocation.literalOptionValue),
    singularOptions: z.literal(invocation.singularOptions),
    jsonFailure: z.literal(invocation.jsonFailure),
    jsonSuccessDiagnostics: z.literal(invocation.jsonSuccessDiagnostics),
    canonicalArgv: z.tuple([
      z.literal(invocation.canonicalArgv[0]),
      z.literal(invocation.canonicalArgv[1]),
      z.literal(invocation.canonicalArgv[2]),
      z.literal(invocation.canonicalArgv[3]),
      z.literal(invocation.canonicalArgv[4]),
    ]),
    version: z.strictObject({
      spellings: z.array(z.string()),
      placement: z.literal(invocation.version.placement),
      stdout: z.literal("text"),
      exitCode: z.literal(0),
    }),
    help: z.strictObject({
      spellings: z.array(z.string()),
      stdout: z.literal("text"),
      exitCode: z.literal(0),
      precedence: z.literal(invocation.help.precedence),
      scansRouterOptionsFirst: z.literal(true),
    }),
  }),
  commands: z
    .array(
      z.strictObject({
        path: z.array(z.string()).min(1),
        summary: z.string(),
        input: commandInputSchema,
        effects: commandEffectsSchema,
        confirmation: commandConfirmationSchema,
        results: z.array(commandResultSchema).min(1).readonly(),
      }),
    )
    .min(1),
  error: z.strictObject({
    schemaRef: resultReferenceSchema,
    exitCode: z.literal(1),
    stream: z.literal("stderr"),
  }),
  schemas: z.strictObject({
    $schema: z.literal("http://json-schema.org/draft-07/schema#"),
    // Schema documents contain JSON values rather than another manifest instance.
    definitions: z.record(z.string(), z.record(z.string(), jsonValueSchema)),
  }),
});
