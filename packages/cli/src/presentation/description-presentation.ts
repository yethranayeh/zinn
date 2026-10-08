export function formatDescriptionPreview(
  description: string | null,
  options: { maxLength?: number } = {},
) {
  const previewLength = options.maxLength ?? 80;

  if (description == null) {
    return "";
  }

  const normalizedDescription = description.replace(/\s+/g, " ").trim();

  if (normalizedDescription.length <= previewLength) {
    return normalizedDescription;
  }

  return `${normalizedDescription.slice(0, previewLength - 1).trimEnd()}…`;
}
