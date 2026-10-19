export function normalizeTextLineEndings(text: string) {
  // Normalize CRLF for consistent storage and matching: https://git-scm.com/docs/gitattributes#_text
  return text.replaceAll("\r\n", "\n");
}
