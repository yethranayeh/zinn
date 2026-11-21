import { expect, test } from "bun:test";
import { inlineMarkdown, parseInline } from "../src/components/inspector/inline";

test("parses code, bold, links and keys into tokens", () => {
  expect(
    parseInline(
      "Use `zinn task view` or **Review**, see [identity](/docs/cli/identity) and <kbd>Esc</kbd>.",
    ),
  ).toEqual([
    { kind: "text", value: "Use " },
    { kind: "code", value: "zinn task view" },
    { kind: "text", value: " or " },
    { kind: "strong", value: "Review" },
    { kind: "text", value: ", see " },
    { kind: "link", text: "identity", href: "/docs/cli/identity" },
    { kind: "text", value: " and " },
    { kind: "key", value: "Esc" },
    { kind: "text", value: "." },
  ]);
});

test("leaves unmatched markers as text", () => {
  expect(parseInline("A ` and a [ and ** and <kbd>Esc")).toEqual([
    { kind: "text", value: "A ` and a [ and ** and <kbd>Esc" },
  ]);
});

test("Markdown keeps the text and opens local links on the site", () => {
  expect(
    inlineMarkdown("Press <kbd>Esc</kbd> and read [settings](/docs/settings)."),
  ).toBe("Press `Esc` and read [settings](https://zinn.sh/docs/settings).");
  expect(inlineMarkdown("[OpenCode](https://opencode.ai/docs)")).toBe(
    "[OpenCode](https://opencode.ai/docs)",
  );
});
