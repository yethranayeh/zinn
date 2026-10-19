import { z } from "zod";

import { fullTextOrPartialEdit } from "./text-edit.js";
import { normalizeTextLineEndings, validateTextSize } from "./text.js";

/**
 * A standard description field schema reused by many fields.
 * Aims to establish a predictable outcome at every aspect of Zinn,
 *  where descriptions are utilized.
 */
export const descriptionSchema = z
  .string()
  .nullable()
  .superRefine(validateTextSize)
  .transform((description) =>
    description === null || description.trim().length === 0
      ? null
      : normalizeTextLineEndings(description),
  );

/** A description in an edit: the full text, or one text edit applied to the stored description. */
export const descriptionEditSchema = fullTextOrPartialEdit(descriptionSchema);
