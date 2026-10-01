import { z } from "zod";

/**
 * A standard description field schema reused by many fields.
 * Aims to establish a predictable outcome at every aspect of Zinn,
 *  where descriptions are utilized.
 */
export const descriptionSchema = z
  .string()
  .nullable()
  .transform((description) =>
    description === null || description.trim().length === 0 ? null : description,
  );
