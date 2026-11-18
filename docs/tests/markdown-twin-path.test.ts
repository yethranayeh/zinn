import { expect, test } from "bun:test";
import { markdownTwinPath } from "../src/markdown/twin-path";

test.each([
  ["/", "/index.md"],
  ["/docs/cli", "/docs/cli.md"],
  ["/docs/cli/", "/docs/cli.md"],
])("the Markdown twin of %s is %s", (pathname, expected) => {
  expect(markdownTwinPath(pathname)).toBe(expected);
});
