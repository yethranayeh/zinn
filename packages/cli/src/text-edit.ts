import type { TextEdit } from "@zinn-dev/core";
import type { TextFlag, TextValues } from "./text-input.js";
import type { InputConstraint } from "./input.js";

import { quit } from "./lib.js";
import { getOptionInputs, violatesConstraint } from "./input.js";
import { resolveTextInput, textOptionNames, textSourceConstraint } from "./text-input.js";

/** The flags that change how a text flag (--description, --text) is applied to the stored text. */
export const textEditOptions = {
  append: { type: "boolean" },
  replacing: { type: "string", value: { kind: "text", name: "old" } },
  all: { type: "boolean" },
} as const;

export function textEditConstraints(textFlag: TextFlag) {
  const textSources = textSourceConstraint(textFlag).members;

  return [
    { kind: "exclusive", members: ["option:append", "option:replacing"] },
    { kind: "requiresAny", input: "option:append", members: textSources },
    { kind: "requiresAny", input: "option:replacing", members: textSources },
    { kind: "requires", input: "option:all", requires: "option:replacing" },
  ] as const satisfies readonly InputConstraint[];
}

type TextEditFlags = TextValues & {
  append?: boolean | undefined;
  replacing?: string | undefined;
  all?: boolean | undefined;
};

/** Help paragraph for the text-edit flags of a command whose text flag is `textFlag`. */
export function textEditHelp(textFlag: TextFlag) {
  return `--append adds ${textFlag} as a new paragraph.
--replacing <old> replaces one exact, case-sensitive match; --all replaces every match.
No match, or several without --all, fails without changes. ${textFlag} '' with --replacing deletes the match.`;
}

/**
 * The value to send to core for a text flag: the full text, or one edit object.
 * The text comes inline or from its file flag, which is read only after the flag checks pass.
 */
export async function resolveTextEdit(
  flags: TextEditFlags,
  textFlag: TextFlag,
): Promise<string | TextEdit | undefined> {
  const isAppending = flags.append === true;
  const [exclusiveModifiers, appendRequiresText, replacingRequiresText, allRequiresReplacing] =
    textEditConstraints(textFlag);
  const { text, file } = textOptionNames(textFlag);
  const inputs = getOptionInputs(flags);

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
    quit(`Option "${modifier}" needs "${textFlag}" or "--${file}"`, undefined, {
      argument: textFlag,
    });
  }

  if (violatesConstraint(allRequiresReplacing, inputs)) {
    quit(`Option "--all" needs "--replacing"`, undefined, { argument: "--all" });
  }

  const resolvedText = await resolveTextInput(flags[text], flags[file], textFlag);
  if (resolvedText === undefined) {
    return undefined;
  }

  if (isAppending) {
    return { append: resolvedText };
  }

  if (flags.replacing !== undefined) {
    return flags.all === true
      ? { find: flags.replacing, replace: resolvedText, all: true }
      : { find: flags.replacing, replace: resolvedText };
  }

  return resolvedText;
}
