const DEFAULT_PREVIEW_LENGTH = 80;

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

  return `${normalizedDescription.slice(0, previewLength - 1).trimEnd()}…`;
}
