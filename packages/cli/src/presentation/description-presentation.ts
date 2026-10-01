export function formatDescriptionPreview(description: string | null) {
  const DESCRIPTION_PREVIEW_LENGTH = 80;

  if (description == null) {
    return "";
  }

  const normalizedDescription = description.replace(/\s+/g, " ").trim();

  if (normalizedDescription.length <= DESCRIPTION_PREVIEW_LENGTH) {
    return normalizedDescription;
  }

  return `${normalizedDescription.slice(0, DESCRIPTION_PREVIEW_LENGTH - 1).trimEnd()}…`;
}
