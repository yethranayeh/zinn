import type { TextEdit } from "@zinn-dev/core";

import { quit } from "./lib.js";

/** The flags that change how a text flag (--description, --text) is applied to the stored text. */
export const textEditOptions = {
  append: { type: "boolean" },
  replacing: { type: "string" },
  all: { type: "boolean" },
} as const;

type TextEditFlags = {
  append?: boolean | undefined;
  replacing?: string | undefined;
  all?: boolean | undefined;
};

/** The usage form of the text-edit flags, to follow the text flag in a usage line. */
export const textEditUsage = "[--append|--replacing <old> [--all]]";

/** Help paragraph for the text-edit flags of a command whose text flag is `textFlag`. */
export function textEditHelp(textFlag: "--description" | "--text") {
  return `With --append, the ${textFlag} text is added as a new paragraph.
With --replacing <old>, it replaces the one exact, case-sensitive match of <old>
--all replaces every match.

No match, or several matches without --all, fails without changing anything.
An empty ${textFlag} with --replacing deletes the match.`;
}

/** The value to send to core for a text flag: the full text, or one edit object. */
export function resolveTextEdit(
  text: string | undefined,
  flags: TextEditFlags,
  textFlag: "--description" | "--text",
): string | TextEdit | undefined {
  const isAppending = flags.append === true;
  const isReplacing = flags.replacing !== undefined;

  if (isAppending && isReplacing) {
    quit(`Option "--append" cannot be used with "--replacing"`);
  }

  if ((isAppending || isReplacing) && text === undefined) {
    const modifier = isAppending ? "--append" : "--replacing";
    quit(`Option "${modifier}" needs "${textFlag}"`);
  }

  if (flags.all === true && !isReplacing) {
    quit(`Option "--all" needs "--replacing"`);
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
