import type { ParseArgsOptionsConfig } from "node:util";

export type InputValue = {
  kind: string;
  name?: string;
  choices?: readonly string[];
  caseInsensitive?: boolean;
  pattern?: string;
  description?: string;
};

export type InputOption = ParseArgsOptionsConfig[string] & {
  required?: boolean;
  value?: InputValue;
  description?: string;
};

export type InputOptions = Record<string, InputOption>;
export type PositionalInput = {
  name: string;
  min: 0 | 1;
  max: 1 | null;
  value: InputValue;
};
export type InputForm = { id: string; positionals: readonly PositionalInput[] };
export type InputReference = `option:${string}` | `positional:${string}`;
export type InputConstraint =
  | { kind: "exclusive"; members: readonly InputReference[] }
  | { kind: "requires"; input: InputReference; requires: InputReference }
  | { kind: "atLeastOne"; members: readonly InputReference[] };

export type CommandInput = {
  options: InputOptions;
  forms: readonly InputForm[];
  constraints: readonly InputConstraint[];
  notes?: readonly string[];
};

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
