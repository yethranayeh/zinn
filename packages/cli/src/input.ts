import { z } from "zod";

export const inputValueSchema = z.strictObject({
  kind: z.string(),
  name: z.string().optional(),
  choices: z.array(z.string()).readonly().optional(),
  caseInsensitive: z.boolean().optional(),
  pattern: z.string().optional(),
  description: z.string().optional(),
});
export const inputOptionSchema = z.strictObject({
  type: z.enum(["string", "boolean"]),
  short: z.string().optional(),
  multiple: z.boolean().optional(),
  default: z.union([z.string(), z.boolean(), z.array(z.string()), z.array(z.boolean())]).optional(),
  required: z.boolean().optional(),
  value: inputValueSchema.optional(),
  description: z.string().optional(),
});
export const inputOptionsSchema = z.record(z.string(), inputOptionSchema);
const inputReferenceSchema = z.templateLiteral([
  z.enum(["option:", "positional:"]),
  z.string().min(1),
]);
const members = z.array(inputReferenceSchema).readonly();
const inputConstraintSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exclusive"), members }),
  z.strictObject({
    kind: z.literal("requires"),
    input: inputReferenceSchema,
    requires: inputReferenceSchema,
  }),
  z.strictObject({ kind: z.literal("atLeastOne"), members }),
]);
const positionalInputSchema = z.strictObject({
  name: z.string(),
  min: z.union([z.literal(0), z.literal(1)]),
  max: z.literal(1).nullable(),
  value: inputValueSchema,
});
const inputFormSchema = z.strictObject({
  id: z.string(),
  positionals: z.array(positionalInputSchema).readonly(),
});
export const commandInputSchema = z.strictObject({
  options: inputOptionsSchema,
  forms: z.array(inputFormSchema).min(1).readonly(),
  constraints: z.array(inputConstraintSchema).readonly(),
  notes: z.array(z.string()).readonly().optional(),
});

export type InputValue = z.infer<typeof inputValueSchema>;
export type InputOption = z.infer<typeof inputOptionSchema>;
export type InputOptions = z.infer<typeof inputOptionsSchema>;
export type PositionalInput = z.infer<typeof positionalInputSchema>;
export type InputForm = z.infer<typeof inputFormSchema>;
export type InputReference = z.infer<typeof inputReferenceSchema>;
export type InputConstraint = z.infer<typeof inputConstraintSchema>;
export type CommandInput = z.infer<typeof commandInputSchema>;

export const taskKeyPositional = {
  name: "task-key",
  min: 1,
  max: 1,
  value: { kind: "task-key" },
} as const satisfies PositionalInput;

export const noInput = {
  options: {},
  forms: [{ id: "default", positionals: [] }],
  constraints: [],
} as const satisfies CommandInput;

export const archiveConstraint = {
  kind: "exclusive",
  members: ["option:archived", "option:all"],
} as const satisfies InputConstraint;

export const routerOptionNames = { json: "json", legacyRead: "allow-legacy-read" } as const;
export const routerOptions = {
  [routerOptionNames.json]: { type: "boolean" },
  [routerOptionNames.legacyRead]: { type: "boolean" },
} as const;
export const helpSpellings: readonly string[] = ["-h", "--help"];
export const versionSpellings: readonly string[] = ["-v", "--version"];

export const invocation = {
  routerOptions,
  routerOptionPlacement: "exact-tokens-anywhere-before-separator",
  optionSeparator: "--",
  literalOptionValue: "equals",
  singularOptions: "reject-repetition",
  jsonFailure: "one-stderr-document-with-buffered-diagnostics",
  jsonSuccessDiagnostics: "text-on-stderr-at-completion",
  canonicalArgv: [
    "command-path",
    "options-with-equals-values",
    "--json",
    "separator-if-positionals",
    "positionals",
  ],
  version: { spellings: versionSpellings, placement: "sole-argument", stdout: "text", exitCode: 0 },
  help: {
    spellings: helpSpellings,
    stdout: "text",
    exitCode: 0,
    precedence: "root-first-token-otherwise-router-prefix-before-help",
    scansRouterOptionsFirst: true,
  },
} as const;

/** Formats the same positional facts used by validation */
export function positionalWords(form: InputForm): string[] {
  return form.positionals.map(({ name, min, max, value }) => {
    const word = value.choices === undefined ? `<${name}>` : `{${value.choices.join("|")}}`;
    const repeatedWord = max === null ? `${word}...` : word;
    return min === 0 ? `[${repeatedWord}]` : repeatedWord;
  });
}

/** Validates structure without tripping on empty strings */
export function violatesConstraint(
  constraint: InputConstraint,
  inputs: Partial<Record<InputReference, unknown>>,
): boolean {
  const supplied = (reference: InputReference) =>
    inputs[reference] !== undefined && inputs[reference] !== false;

  switch (constraint.kind) {
    case "exclusive":
      return constraint.members.filter(supplied).length > 1;
    case "requires":
      return supplied(constraint.input) && !supplied(constraint.requires);
    case "atLeastOne":
      return !constraint.members.some(supplied);
  }
}

export function getOptionInputs(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [`option:${name}`, value]),
  ) as Partial<Record<InputReference, unknown>>;
}

/** Generates syntax without the explanatory help stuff */
export function generateInputUsage(input: CommandInput): string[] {
  const options = Object.entries(input.options).map(([name, option]) => {
    const value = option.value;
    const valueWord = `<${value?.name ?? "text"}>`;
    const flag = `--${name}${option.type === "string" ? ` ${valueWord}` : ""}`;

    return {
      reference: `option:${name}`,
      word: `${option.required ? flag : `[${flag}]`}${option.multiple ? "..." : ""}`,
    };
  });

  return input.forms.map((form) => {
    const words = new Map([
      ...form.positionals.map(
        (positional, index) =>
          [`positional:${positional.name}`, positionalWords(form)[index]!] as const,
      ),
      ...options.map(({ reference, word }) => [reference, word] as const),
    ]);

    // Text modifiers share one syntax group with the text they change
    const textRequirement = input.constraints.find(
      (constraint) => constraint.kind === "requires" && constraint.input === "option:append",
    );

    if (textRequirement?.kind === "requires") {
      const textReference = textRequirement.requires;
      const textName = textReference.slice("option:".length);
      const textOption = input.options[textName]!;
      const text = `--${textName} <${textOption.value?.name ?? "text"}>`;
      const replacing = words.get("option:replacing")!.slice(1, -1);
      const modifiers = `[--append|${replacing} ${words.get("option:all")}]`;

      words.set(
        textReference,
        textOption.required ? `${text} ${modifiers}` : `[${text} ${modifiers}]`,
      );

      for (const name of ["append", "replacing", "all"]) {
        words.delete(`option:${name}`);
      }
    }

    for (const constraint of input.constraints) {
      const hasEveryMemberWord =
        constraint.kind === "exclusive" && constraint.members.every((member) => words.has(member));

      if (!hasEveryMemberWord) {
        continue;
      }

      const alternatives = constraint.members.map((member) => words.get(member)!.slice(1, -1));
      words.set(constraint.members[0]!, `[${alternatives.join("|")}]`);

      for (const member of constraint.members.slice(1)) {
        words.delete(member);
      }
    }
    return [...words.values()].join(" ");
  });
}

export const usageLabel = "Usage: ";
export function generateCommandUsage(path: string, input: CommandInput): string {
  return generateInputUsage(input)
    .map(
      (syntax, index) =>
        `${index === 0 ? usageLabel : " ".repeat(usageLabel.length)}zinn ${path}${
          syntax === "" ? "" : ` ${syntax}`
        }`,
    )
    .join("\n");
}
