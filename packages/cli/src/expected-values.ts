import type { InputConstraint, InputOption } from "./input.js";
import type { TextFlag } from "./text-input.js";

import {
  checkSingleTextSource,
  resolveTextInput,
  textFileHelp,
  textFileOption,
  textOptionNames,
  textSourceConstraint,
} from "./text-input.js";

const expectTextOption = { type: "string", value: { kind: "text", name: "text" } } as const;

/** A guarded field whose flag value is parsed on its own, such as a `title` or a `priority` */
type ValueGuard = {
  field: string;
  option: InputOption;
  parse?: (value: string | undefined, flag: string) => unknown;
};

/** A guarded field whose text comes inline or from a file, like the text flag it guards */
type TextGuard = { field: string; text: true };

type Guards = Record<string, ValueGuard | TextGuard>;

type ExpectOptions<G extends Guards> = {
  [Name in keyof G & string as `expect-${Name}`]: G[Name] extends ValueGuard
    ? G[Name]["option"]
    : typeof expectTextOption;
} & {
  [Name in keyof G & string as G[Name] extends TextGuard
    ? `expect-${Name}-file`
    : never]: typeof textFileOption;
};

/** Parsed flag values of a command. Every expect flag holds one string. */
type ParsedValues = Record<string, unknown>;

const stringValue = (values: ParsedValues, name: string) => values[name] as string | undefined;

const isTextGuard = (guard: ValueGuard | TextGuard): guard is TextGuard => "text" in guard;

function joinFlags(flags: Array<string>) {
  return flags.length < 2 ? flags.join("") : `${flags.slice(0, -1).join(", ")} and ${flags.at(-1)}`;
}

/**
 * Declares `--expect-<name>` flags, which give the stored values an edit expects to replace.
 * Each key is a flag name, and its guard names the core field the flag checks.
 */
export function expectedValueFlags<const G extends Guards>(guards: G) {
  const entries = Object.entries(guards);
  const valueGuards = entries.filter(
    (entry): entry is [string, ValueGuard] => !isTextGuard(entry[1]),
  );
  const textGuards = entries.filter((entry): entry is [string, TextGuard] => isTextGuard(entry[1]));
  const textFlags = textGuards.map(([name]) => `--expect-${name}` as TextFlag);

  const options: Record<string, InputOption> = {};
  for (const [name, guard] of entries) {
    if (isTextGuard(guard)) {
      options[`expect-${name}`] = expectTextOption;
      options[`expect-${name}-file`] = textFileOption;
    } else {
      options[`expect-${name}`] = guard.option;
    }
  }

  const flagNames = entries.map(([name]) => `--expect-${name}`);
  const help = [
    `${joinFlags(flagNames)} give the values read before the edit, spelled as for the edit flags. If one of them no longer matches the stored value, the edit fails and changes nothing.`,
    ...textFlags.map(textFileHelp),
  ].join("\n");

  return {
    options: options as ExpectOptions<G>,
    constraints: textFlags.map(textSourceConstraint) satisfies InputConstraint[],
    textFlags,
    help,
    /** Parses every flag that needs no file or stdin, and refuses inline text together with its file flag. */
    parseValues(values: ParsedValues) {
      for (const textFlag of textFlags) {
        const { text, file } = textOptionNames(textFlag);
        checkSingleTextSource(stringValue(values, text), stringValue(values, file), textFlag);
      }

      return Object.fromEntries(
        valueGuards.map(([name, guard]) => {
          const flag = `expect-${name}`;
          const value = stringValue(values, flag);
          return [guard.field, guard.parse === undefined ? value : guard.parse(value, `--${flag}`)];
        }),
      );
    },

    /** Reads the expected text values, inline or from their file flags. */
    async resolveText(values: ParsedValues) {
      const resolved: Record<string, string | undefined> = {};
      for (const [index, [, guard]] of textGuards.entries()) {
        const textFlag = textFlags[index]!;
        const { text, file } = textOptionNames(textFlag);
        resolved[guard.field] = await resolveTextInput(
          stringValue(values, text),
          stringValue(values, file),
          textFlag,
        );
      }

      return resolved;
    },
  };
}
