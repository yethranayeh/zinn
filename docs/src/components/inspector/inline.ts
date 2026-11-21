export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "key"; value: string };

const code = /^`([^`]+)`/;
const strong = /^\*\*([^*]+)\*\*/;
const link = /^\[([^\]]+)\]\(([^)]+)\)/;
const key = /^<kbd>([^<]+)<\/kbd>/;

/** Parses code spans, bold text, Markdown links and key caps. Forms cannot nest. */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let rest = text;

  const pushText = (value: string) => {
    const last = tokens.at(-1);
    if (last?.kind === "text") {
      last.value += value;
    } else {
      tokens.push({ kind: "text", value });
    }
  };

  while (rest.length > 0) {
    const codeMatch = code.exec(rest);
    if (codeMatch) {
      tokens.push({ kind: "code", value: codeMatch[1]! });
      rest = rest.slice(codeMatch[0].length);
      continue;
    }

    const strongMatch = strong.exec(rest);
    if (strongMatch) {
      tokens.push({ kind: "strong", value: strongMatch[1]! });
      rest = rest.slice(strongMatch[0].length);
      continue;
    }

    const linkMatch = link.exec(rest);
    if (linkMatch) {
      tokens.push({ kind: "link", text: linkMatch[1]!, href: linkMatch[2]! });
      rest = rest.slice(linkMatch[0].length);
      continue;
    }

    const keyMatch = key.exec(rest);
    if (keyMatch) {
      tokens.push({ kind: "key", value: keyMatch[1]! });
      rest = rest.slice(keyMatch[0].length);
      continue;
    }

    pushText(rest[0]!);
    rest = rest.slice(1);
  }

  return tokens;
}

/** The same text as Markdown, with key caps as code spans and local links absolute. */
export function inlineMarkdown(text: string): string {
  return text
    .replace(/<kbd>([^<]+)<\/kbd>/g, "`$1`")
    .replace(/\]\(\/(?!\/)/g, "](https://zinn.sh/");
}
