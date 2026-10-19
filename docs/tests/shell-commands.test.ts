import { expect, test } from "bun:test";
import { splitShellCommands } from "../src/markdown/shell-commands";

test("splits adjacent commands and ignores blank separator lines", () => {
  expect(splitShellCommands("zinn info\nzinn info --json\n")).toEqual([
    "zinn info",
    "zinn info --json",
  ]);
  expect(splitShellCommands("\nzinn info\n\n\nzinn info --json\n\n")).toEqual([
    "zinn info",
    "zinn info --json",
  ]);
  expect(splitShellCommands("zinn info\r\nzinn info --json\r\n")).toEqual([
    "zinn info",
    "zinn info --json",
  ]);
});

test("keeps backslash continuations with their command", () => {
  const command = [
    "zinn task create DEMO \\",
    "  --title 'Write release notes' \\",
    "  --priority high",
  ];
  const source = [...command, "zinn task list DEMO"].join("\n");
  expect(splitShellCommands(source)).toEqual([command.join("\n"), "zinn task list DEMO"]);
});

test("keeps a heredoc inside command substitution with its command", () => {
  const command = [
    "zinn task edit MDR-1 --description=\"$(cat <<'EOF'",
    "- Bring waffles.",
    '- Count the `numbers` for $5 and "Kier".',
    "EOF",
    ')"',
  ];
  const source = [command.join("\n"), "zinn task list MDR"].join("\n");
  expect(splitShellCommands(source)).toEqual([command.join("\n"), "zinn task list MDR"]);
});

test("ends a plain heredoc before the next command", () => {
  const source = ["cat <<'EOF'", "hello", "EOF", "zinn task list MDR"].join("\n");
  expect(splitShellCommands(source)).toEqual(["cat <<'EOF'\nhello\nEOF", "zinn task list MDR"]);
});

test("does not treat a quoted heredoc marker as a heredoc", () => {
  const source = ["zinn task edit MDR-1 --description 'compare a << b'", "zinn task list MDR"].join(
    "\n",
  );
  expect(splitShellCommands(source)).toEqual([
    "zinn task edit MDR-1 --description 'compare a << b'",
    "zinn task list MDR",
  ]);
});
