import { styleOutputText } from "./color";

/** A bold heading line, with the colon bolded along with the word, above its body. */
export function formatSection(heading: string, body: string) {
  return `${styleOutputText("bold", `${heading}:`)}\n${body}`;
}
