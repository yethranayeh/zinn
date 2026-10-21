const DEFAULT_PREVIEW_LENGTH = 80;

/**
 * Formats a description preview, capped at `maxLength` (80 by default)
 * and ending with an ellipsis when shortened.
 *
 * The cap counts UTF-16 units, which means it can land inside an emoji 😀
 *  and cut it in half 🫡.
 * The cut half cannot render, so it is dropped.
 *
 * @example
 * // The cut lands after both halves, so the emoji is kept.
 * formatDescriptionPreview("a😀zz", { maxLength: 4 }); // "a😀…"
 *
 * @example
 * // The cut lands between the halves, so the orphaned half is dropped.
 * formatDescriptionPreview("a😀z", { maxLength: 3 }); // "a…"
 */
export function formatDescriptionPreview(
  description: string | null,
  options: { maxLength?: number; firstLineOnly?: boolean } = {},
) {
  const previewLength = options.maxLength ?? DEFAULT_PREVIEW_LENGTH;

  if (description == null) {
    return "";
  }

  const lineBreakIndex = options.firstLineOnly ? description.search(/\r?\n/) : -1;
  const hasMoreLines = lineBreakIndex !== -1;
  const previewText = hasMoreLines ? description.slice(0, lineBreakIndex) : description;
  const normalizedDescription = previewText.replace(/\s+/g, " ").trim();

  if (normalizedDescription.length <= previewLength && !hasMoreLines) {
    return normalizedDescription;
  }

  const truncatedDescription = normalizedDescription.slice(0, previewLength - 1);
  const completePrefix = truncatedDescription.replace(/\p{Surrogate}$/u, "");
  return `${completePrefix.trimEnd()}…`;
}
