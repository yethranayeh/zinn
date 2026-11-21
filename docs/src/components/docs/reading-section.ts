/**
 * The page's table of contents tracks which h2 section the reader is in.
 * It keeps the section's id in the root element's `data-reading-section`,
 *  empty above the first h2, and announces each change
 *  with this document event, whose detail is that id.
 */
export const readingSectionEvent = "readingsectionchange";

export function currentReadingSection() {
  return document.documentElement.dataset.readingSection;
}
