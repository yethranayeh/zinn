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
  z.strictObject({ kind: z.literal("requiresAny"), input: inputReferenceSchema, members }),
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

export const routerOptionNames = { json: "json" } as const;
export const routerOptions = {
  [routerOptionNames.json]: { type: "boolean" },
} as const;
export const helpSpellings: readonly string[] = ["-h", "--help"];
export const versionSpellings: readonly string[] = ["-v", "--version"];
export const OPTION_SEPARATOR = "--";

export function isJsonFlag(flag: string) {
  return flag === `--${routerOptionNames.json}`;
}

/** A flag the router reads wherever it appears before --, for every command. */
export function isRouterFlag(flag: string) {
  return isJsonFlag(flag);
}

export function isHelpFlag(flag: string) {
  return helpSpellings.includes(flag);
}

/** The words before the first `--`, and the rest starting with that `--` */
export function splitAtOptionSeparator(words: Array<string>) {
  const separatorIndex = words.indexOf(OPTION_SEPARATOR);

  return separatorIndex === -1
    ? { optionWords: words, passthroughWords: [] }
    : {
        optionWords: words.slice(0, separatorIndex),
        passthroughWords: words.slice(separatorIndex),
      };
}

export const invocation = {
  routerOptions,
  routerOptionPlacement: "exact-tokens-anywhere-before-separator",
  optionSeparator: OPTION_SEPARATOR,
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
    case "requiresAny":
      return supplied(constraint.input) && !constraint.members.some(supplied);
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
    const valueWord =
      value?.name === undefined && value?.choices !== undefined
        ? `{${value.choices.join("|")}}`
        : `<${value?.name ?? "text"}>`;
    const flag = `--${name}${option.type === "string" ? ` ${valueWord}` : ""}`;

    return {
      reference: `option:${name}`,
      word: `${option.required ? flag : `[${flag}]`}${option.multiple ? "..." : ""}`,
    };
  });

  /**
   * Exclusive inputs that also need one of them are a required choice: (a|b) instead of [a|b],
   *  like how it is in git's synopsis notation.
   * {a|b} stays reserved for a choice of literal words.
   */
  const isRequiredChoice = (members: readonly InputReference[]) =>
    input.constraints.some(
      (constraint) =>
        constraint.kind === "atLeastOne" &&
        constraint.members.length === members.length &&
        constraint.members.every((member) => members.includes(member)),
    );
  const choice = (alternatives: readonly string[], isRequired: boolean) =>
    isRequired ? `(${alternatives.join("|")})` : `[${alternatives.join("|")}]`;

  return input.forms.map((form) => {
    const words = new Map([
      ...form.positionals.map(
        (positional, index) =>
          [`positional:${positional.name}`, positionalWords(form)[index]!] as const,
      ),
      ...options.map(({ reference, word }) => [reference, word] as const),
    ]);

    // Text modifiers share one syntax group with the text sources they change
    const textRequirement = input.constraints.find(
      (constraint) => constraint.kind === "requiresAny" && constraint.input === "option:append",
    );

    if (textRequirement?.kind === "requiresAny") {
      const sources = textRequirement.members;
      const sourceSyntax = sources.map((reference) => {
        const name = reference.slice("option:".length);
        return `--${name} <${input.options[name]!.value?.name ?? "text"}>`;
      });
      const isRequired = isRequiredChoice(sources);
      const source = sourceSyntax.length === 1 ? sourceSyntax[0]! : choice(sourceSyntax, true);
      const replacing = words.get("option:replacing")!.slice(1, -1);
      const group = `${source} [--append|${replacing} ${words.get("option:all")}]`;

      words.set(sources[0]!, isRequired ? group : `[${group}]`);

      // The words written inside the first source's group
      const foldedReferences = [
        ...sources.slice(1),
        "option:append",
        "option:replacing",
        "option:all",
      ];

      for (const reference of foldedReferences) {
        words.delete(reference);
      }
    }

    for (const constraint of input.constraints) {
      const hasEveryMemberWord =
        constraint.kind === "exclusive" && constraint.members.every((member) => words.has(member));

      if (!hasEveryMemberWord) {
        continue;
      }

      const alternatives = constraint.members.map((member) => words.get(member)!.slice(1, -1));
      words.set(constraint.members[0]!, choice(alternatives, isRequiredChoice(constraint.members)));

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
