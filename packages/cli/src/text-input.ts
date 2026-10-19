import { Buffer } from "node:buffer";
import { constants, promises as fs, type Stats } from "node:fs";
import { MAX_TEXT_BYTES } from "@zinn-dev/core";

import { CliError, classifyFailure } from "./errors.js";

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
  textFlag: "--description" | "--text",
): Promise<string | undefined> {
  const fileFlag = `${textFlag}-file`;
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
    throw new CliError(`Cannot read ${fileFlag} ${JSON.stringify(path)}.`, failure.code, {
      ...failure.details,
      argument: fileFlag,
      path,
    });
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
