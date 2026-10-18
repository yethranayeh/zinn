import { z } from "zod";
import { invocation } from "./input.js";

export const jsonValueSchema = z.json();
const inputValue = z.strictObject({
  kind: z.string(),
  name: z.string().optional(),
  choices: z.array(z.string()).optional(),
  caseInsensitive: z.boolean().optional(),
  pattern: z.string().optional(),
  description: z.string().optional(),
});
const inputOption = z.strictObject({
  type: z.enum(["string", "boolean"]),
  short: z.string().optional(),
  multiple: z.boolean().optional(),
  default: z.union([z.string(), z.boolean(), z.array(z.string()), z.array(z.boolean())]).optional(),
  required: z.boolean().optional(),
  value: inputValue.optional(),
  description: z.string().optional(),
});
const options = z.record(z.string(), inputOption);
const inputReference = z.string().regex(/^(option|positional):.+$/);
const members = z.array(inputReference);
const constraint = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exclusive"), members }),
  z.strictObject({ kind: z.literal("requires"), input: inputReference, requires: inputReference }),
  z.strictObject({ kind: z.literal("atLeastOne"), members }),
]);
const form = z.strictObject({
  id: z.string(),
  positionals: z.array(
    z.strictObject({
      name: z.string(),
      min: z.union([z.literal(0), z.literal(1)]),
      max: z.literal(1).nullable(),
      value: inputValue,
    }),
  ),
});
const selector = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("always") }),
  z.strictObject({ kind: z.literal("booleanOption"), name: z.string(), value: z.boolean() }),
  z.strictObject({
    kind: z.literal("positionalCount"),
    name: z.string(),
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative().nullable(),
  }),
]);
const schemaRef = z.string().regex(/^#\/schemas\/definitions\/[^/]+$/);

export const capabilitiesSchema = z.strictObject({
  manifestVersion: z.literal(1),
  cli: z.strictObject({ name: z.string(), version: z.string() }),
  invocation: z.strictObject({
    routerOptions: options,
    routerOptionPlacement: z.literal(invocation.routerOptionPlacement),
    optionSeparator: z.literal(invocation.optionSeparator),
    literalOptionValue: z.literal(invocation.literalOptionValue),
    singularOptions: z.literal(invocation.singularOptions),
    jsonFailure: z.literal(invocation.jsonFailure),
    jsonSuccessDiagnostics: z.literal(invocation.jsonSuccessDiagnostics),
    canonicalArgv: z
      .array(z.enum(invocation.canonicalArgv))
      .length(invocation.canonicalArgv.length),
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
        input: z.strictObject({
          options,
          forms: z.array(form).min(1),
          constraints: z.array(constraint),
          notes: z.array(z.string()).optional(),
        }),
        effects: z.strictObject({
          domain: z.enum(["read", "create", "update", "delete", "replace", "none"]),
          storage: z.enum([
            "normal-open",
            "backup",
            "restore",
            "migrate",
            "reindex",
            "inspect",
            "none",
          ]),
        }),
        confirmation: z.strictObject({
          kind: z.enum(["none", "prompt", "project-delete"]),
          description: z.string().optional(),
        }),
        results: z
          .array(
            z.strictObject({
              selector,
              schemaRef,
              mode: z.literal("json"),
              stream: z.literal("stdout"),
              exitCode: z.literal(0),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  error: z.strictObject({
    schemaRef,
    exitCode: z.literal(1),
    stream: z.literal("stderr"),
  }),
  schemas: z.strictObject({
    $schema: z.literal("http://json-schema.org/draft-07/schema#"),
    // Schema documents contain JSON values rather than another manifest instance.
    definitions: z.record(z.string(), z.record(z.string(), jsonValueSchema)),
  }),
});
