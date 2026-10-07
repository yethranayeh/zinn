import { styleOutputText } from "./color";

/** A bold heading above its body, optionally preceded by a dim horizontal rule. */
export function formatSection(
  heading: string,
  body: string,
  options: { separatorWidth?: number } = {},
) {
  const section = `${styleOutputText("bold", `${heading}:`)}\n${body}`;

  if (options.separatorWidth === undefined) {
    return section;
  }

  return `${styleOutputText("dim", "-".repeat(options.separatorWidth))}\n${section}`;
}
