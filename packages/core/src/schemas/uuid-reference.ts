import { z } from "zod";

export const minimumUuidReferenceLength = 8;
export const UUID_HEX_LENGTH = 32;

export function uuidReferenceSchema(entity: string) {
  return z.string().superRefine((value, context) => {
    const hex = value.replaceAll("-", "").toLowerCase();
    const canonical = hex
      .padEnd(UUID_HEX_LENGTH, "0")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const isHex = /^[\da-f]+$/.test(hex) && hex.length <= UUID_HEX_LENGTH;
    const hasCanonicalHyphens = !value.includes("-") || canonical.startsWith(value.toLowerCase());

    if (!isHex || !hasCanonicalHyphens) {
      context.addIssue({
        code: "custom",
        message: `Invalid ${entity.toLowerCase()} ID. Use a UUID or its left prefix, with canonical hyphens or hexadecimal digits`,
      });
    } else if (hex.length < minimumUuidReferenceLength) {
      context.addIssue({
        code: "custom",
        message: `${entity} ID prefixes need at least ${minimumUuidReferenceLength} hexadecimal digits`,
      });
    }
  });
}

/** Returns the compact lowercase spelling used to resolve a UUID prefix */
export function normalizeUuidReference(value: string) {
  return value.replaceAll("-", "").toLowerCase();
}
