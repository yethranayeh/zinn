import type { z } from "zod";

import { Buffer } from "node:buffer";

export const MAX_TEXT_BYTES = 1_048_576;

export function validateTextSize(text: string | null, context: z.RefinementCtx) {
  if (text === null) {
    return;
  }

  const size = Buffer.byteLength(text, "utf8");
  if (size > MAX_TEXT_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Text is ${size} UTF-8 bytes; the limit is ${MAX_TEXT_BYTES} bytes. Nothing was written.`,
    });
  }
}

export function normalizeTextLineEndings(text: string) {
  // Normalize CRLF for consistent storage and matching: https://git-scm.com/docs/gitattributes#_text
  return text.replaceAll("\r\n", "\n");
}
