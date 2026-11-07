import type { InputConstraint, InputOption } from "./input.js";

import { Buffer } from "node:buffer";
import { constants, promises as fs, type Stats } from "node:fs";
import { z } from "zod";
import { isMissingFileError, MAX_TEXT_BYTES } from "@zinn-dev/core";

import { CliError, classifyFailure } from "./errors.js";

/** The option names of each text flag and of the file flag that can supply its text instead */
const textOptions = {
  "--description": { text: "description", file: "description-file" },
  "--text": { text: "text", file: "text-file" },
} as const;

export type TextFlag = keyof typeof textOptions;
export type TextValues = {
  [Name in (typeof textOptions)[TextFlag][keyof (typeof textOptions)[TextFlag]]]?:
    | string
    | undefined;
};

export function textOptionNames(textFlag: TextFlag) {
  return textOptions[textFlag];
}

/** The flag that reads a text flag's value from a file, or from stdin as "-" */
export const textFileOption = {
  type: "string",
  value: {
    kind: "path",
    name: "path",
    description:
      'A UTF-8 file, or "-" for stdin. Trailing line breaks are dropped; empty or blank input is an error.',
  },
} as const satisfies InputOption;

/** Inline text and its file flag are alternatives for the same field */
export function textSourceConstraint(textFlag: TextFlag) {
  const { text, file } = textOptionNames(textFlag);

  return {
    kind: "exclusive",
    members: [`option:${text}`, `option:${file}`],
  } as const satisfies InputConstraint;
}

/**
 * Validates `fields` against their rules in a core input schema, so a command can reject
 *  a bad key, name or title before it reads text from stdin, which cannot be read twice.
 * Rules that span the whole input, such as "at least one field", stay with core.
 */
export function checkFieldsBeforeText(schema: z.ZodObject, fields: Record<string, unknown>) {
  const names = Object.keys(schema.shape).filter((name) => name in fields);
  const shape = Object.fromEntries(names.map((name) => [name, schema.shape[name]!]));
  z.strictObject(shape).parse(fields);
}

export function textFileHelp(textFlag: TextFlag) {
  return `--${textOptionNames(textFlag).file} <path> takes the text from a UTF-8 file, or from stdin when <path> is "-".`;
}

// One extra byte detects oversized input without waiting for EOF.
const READ_LIMIT = MAX_TEXT_BYTES + 1;
const sizeLimitMessage = `Text is at least ${READ_LIMIT} UTF-8 bytes; the limit is ${MAX_TEXT_BYTES} bytes. Nothing was written.`;

async function readTextFile(path: string, refuse: (message: string) => never) {
  const checkFile = (stats: Stats) => {
    if (!stats.isFile()) {
      refuse('Expected a regular file. Use "-" for piped input.');
    }

    if (stats.size > MAX_TEXT_BYTES) {
      refuse(sizeLimitMessage);
    }
  };

  checkFile(await fs.stat(path));

  // A path replaced by a FIFO after stat must not block open.
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    checkFile(await file.stat());
    const bytes = Buffer.allocUnsafe(READ_LIMIT);
    let size = 0;

    while (size < READ_LIMIT) {
      const { bytesRead } = await file.read(bytes, size, READ_LIMIT - size, null);
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
    }

    if (size > MAX_TEXT_BYTES) {
      refuse(sizeLimitMessage);
    }

    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

async function readStdin(fileFlag: string, refuse: (message: string) => never): Promise<Buffer> {
  const input = process.stdin;
  if (input.isTTY) {
    refuse('Stdin is a terminal. Pipe text or supply a file path instead of "-".');
  }

  return new Promise((resolve, reject) => {
    const collected = Buffer.allocUnsafe(READ_LIMIT);
    let size = 0;

    const cleanup = () => {
      input.off("readable", readAvailable);
      input.off("end", finish);
      input.off("error", fail);
      input.off("close", close);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const finish = () => {
      cleanup();
      resolve(collected.subarray(0, size));
    };
    const close = () => {
      fail(
        new CliError("Stdin closed before all text could be read.", "storage", {
          argument: fileFlag,
          path: "-",
          reason: "io",
        }),
      );
    };
    const readAvailable = () => {
      while (size < READ_LIMIT) {
        const available = Math.max(input.readableLength, 1);
        const bytes: Buffer | null = input.read(Math.min(available, READ_LIMIT - size));
        if (bytes === null) {
          return;
        }
        bytes.copy(collected, size);
        size += bytes.length;
        if (size > MAX_TEXT_BYTES) {
          cleanup();
          input.destroy();
          try {
            refuse(sizeLimitMessage);
          } catch (error) {
            reject(error);
          }
        }
      }
    };

    input.on("readable", readAvailable);
    input.once("end", finish);
    input.once("error", fail);
    input.once("close", close);
    readAvailable();
  });
}

/** Resolves one inline or file source before the command opens the database. */
export async function resolveTextInput(
  text: string | undefined,
  path: string | undefined,
  textFlag: TextFlag,
): Promise<string | undefined> {
  const fileFlag = `--${textOptionNames(textFlag).file}`;
  const refuse = (message: string): never => {
    throw new CliError(message, "invalid_input", { argument: fileFlag, path });
  };

  if (text !== undefined && path !== undefined) {
    refuse(`Options "${textFlag}" and "${fileFlag}" cannot be used together.`);
  }

  if (path === undefined) {
    return text;
  }

  let bytes: Buffer;
  try {
    bytes = path === "-" ? await readStdin(fileFlag, refuse) : await readTextFile(path, refuse);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    const failure = classifyFailure(error);
    const code = isMissingFileError(error) ? "not_found" : failure.code;

    throw new CliError(
      `Cannot read ${fileFlag} ${JSON.stringify(path)}.`,
      code,
      { ...failure.details, argument: fileFlag, path },
      undefined,
      undefined,
      error,
    );
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("Input is not valid UTF-8. Save the file as UTF-8.");
  }

  if (decoded.includes("\0")) {
    refuse("Input contains a NUL character. Save the file as UTF-8 text without NUL characters.");
  }

  let end = decoded.length;
  while (end > 0 && decoded[end - 1] === "\n") {
    end -= 1;
    if (end > 0 && decoded[end - 1] === "\r") {
      end -= 1;
    }
  }

  const result = decoded.slice(0, end);
  if (result.trim().length === 0) {
    const clearHint =
      textFlag === "--description" ? ' To clear a description, use --description "".' : "";
    refuse(`Input is empty or blank.${clearHint}`);
  }
  return result;
}
