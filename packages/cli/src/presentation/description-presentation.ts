import { displayWidth, graphemes } from "./text-width.js";

const DEFAULT_PREVIEW_LENGTH = 80;

function formatPreview(
  description: string | null,
  options: { maxLength?: number; firstLineOnly?: boolean },
  measure: (text: string) => number,
) {
  const previewLength = options.maxLength ?? DEFAULT_PREVIEW_LENGTH;
  if (description == null) {
    return "";
  }

  const lineBreakIndex = options.firstLineOnly ? description.search(/\r?\n/) : -1;
  const hasMoreLines = lineBreakIndex !== -1;
  const previewText = hasMoreLines ? description.slice(0, lineBreakIndex) : description;
  const normalizedDescription = previewText.replace(/\s+/g, " ").trim();

  if (measure(normalizedDescription) <= previewLength && !hasMoreLines) {
    return normalizedDescription;
  }

  let prefix = "";
  let prefixLength = 0;
  for (const { segment } of graphemes(normalizedDescription)) {
    const segmentLength = measure(segment);
    if (prefixLength + segmentLength > previewLength - 1) {
      break;
    }
    prefix += segment;
    prefixLength += segmentLength;
  }
  return `${prefix.trimEnd()}…`;
}

/** Formats a visual preview within a terminal-cell budget, including the ellipsis. */
export function formatDescriptionPreview(
  description: string | null,
  options: { maxLength?: number; firstLineOnly?: boolean } = {},
) {
  return formatPreview(description, options, displayWidth);
}

/** Keeps parser reasons within their UTF-16-unit budget. */
export function formatParserReasonPreview(reason: string, maxLength: number) {
  return formatPreview(reason, { maxLength }, (text) => text.length);
}
