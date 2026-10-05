/**
 * Joins a task's comments in its search entry, so phrase queries cannot match across comments.
 * The tokenizer drops whitespace and punctuation, so the boundary needs a token of its own: U+E000
 * The newlines keep it from merging with the neighboring words.
 */
export const SEARCH_COMMENT_SEPARATOR = "\n\uE000\n";

export type SearchEntry = {
  taskId: string;
  title: string;
  description: string | null;
  comments: string;
};

/** Builds a task's search entry. Changing it requires a migration that calls `regenerateSearch`. */
export function assembleSearchEntry(
  task: { id: string; title: string; description: string | null },
  commentTexts: ReadonlyArray<string>,
): SearchEntry {
  return {
    taskId: task.id,
    title: task.title,
    description: task.description,
    comments: commentTexts.join(SEARCH_COMMENT_SEPARATOR),
  };
}
