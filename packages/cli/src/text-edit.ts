import type { TextEdit } from "@zinn-dev/core";

import { quit } from "./lib.js";
import { getOptionInputs, violatesConstraint, type InputConstraint } from "./input.js";

/** The flags that change how a text flag (--description, --text) is applied to the stored text. */
export const textEditOptions = {
  append: { type: "boolean" },
  replacing: { type: "string", value: { kind: "text", name: "old" } },
  all: { type: "boolean" },
} as const;

export function textEditConstraints(textFlag: "--description" | "--text") {
  const textInput = `option:${textFlag.slice(2)}` as const;
  return [
    { kind: "exclusive", members: ["option:append", "option:replacing"] },
    { kind: "requires", input: "option:append", requires: textInput },
    { kind: "requires", input: "option:replacing", requires: textInput },
    { kind: "requires", input: "option:all", requires: "option:replacing" },
  ] as const satisfies readonly InputConstraint[];
}

type TextEditFlags = {
  append?: boolean | undefined;
  replacing?: string | undefined;
  all?: boolean | undefined;
};

/** Help paragraph for the text-edit flags of a command whose text flag is `textFlag`. */
export function textEditHelp(textFlag: "--description" | "--text") {
  return `--append adds ${textFlag} as a new paragraph.
--replacing <old> replaces one exact, case-sensitive match; --all replaces every match.
No match, or several without --all, fails without changes. Empty replacement text deletes the match.`;
}

/** The value to send to core for a text flag: the full text, or one edit object. */
export function resolveTextEdit(
  text: string | undefined,
  flags: TextEditFlags,
  textFlag: "--description" | "--text",
): string | TextEdit | undefined {
  const isAppending = flags.append === true;
  const [exclusiveModifiers, appendRequiresText, replacingRequiresText, allRequiresReplacing] =
    textEditConstraints(textFlag);
  const inputs = getOptionInputs({ ...flags, [textFlag.slice(2)]: text });

  if (violatesConstraint(exclusiveModifiers, inputs)) {
    quit(`Option "--append" cannot be used with "--replacing"`, undefined, {
      argument: "--append",
    });
  }

  if (
    violatesConstraint(appendRequiresText, inputs) ||
    violatesConstraint(replacingRequiresText, inputs)
  ) {
    const modifier = isAppending ? "--append" : "--replacing";
    quit(`Option "${modifier}" needs "${textFlag}"`, undefined, { argument: textFlag });
  }

  if (violatesConstraint(allRequiresReplacing, inputs)) {
    quit(`Option "--all" needs "--replacing"`, undefined, { argument: "--all" });
  }

  if (text === undefined) {
    return undefined;
  }

  if (isAppending) {
    return { append: text };
  }

  if (flags.replacing !== undefined) {
    return flags.all === true
      ? { find: flags.replacing, replace: text, all: true }
      : { find: flags.replacing, replace: text };
  }

  return text;
}
