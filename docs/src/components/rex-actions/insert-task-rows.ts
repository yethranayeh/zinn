// Picker rows for the Insert task illustration: public Zinn tasks, as Zinn: Insert task lists them.
export interface PickerRow {
  key: string;
  title: string;
  subtitle: string;
  column: string;
}

export const pickerRows: PickerRow[] = [
  {
    key: "ZINN-395",
    title: "Fix error-code typing in column hint tests",
    subtitle:
      "The column hint case table infers code as string, causing TS2769 at packages/cli/tests/column-hint.test.ts:66 when compa…",
    column: "In Progress",
  },
  {
    key: "ZINN-372",
    title: "Make the ambiguous activity-reference error test independent of the clock",
    subtitle:
      "The CLI error regression fixture derives an eight-character prefix from the newest UUIDv7 and expects it to match every …",
    column: "In Progress",
  },
  {
    key: "ZINN-334",
    title: "Add a sort direction to task list --sort",
    subtitle:
      "Let callers reverse task list --sort, for example least recently active first to find tasks nobody has touched.",
    column: "Backlog",
  },
  {
    key: "ZINN-181",
    title: "Let task view show several tasks in one command",
    subtitle:
      "Let task view take several task keys, so a caller can read several tasks with one command. Example: after viewing a pare…",
    column: "Backlog",
  },
];

export const pickedKey = "ZINN-334";

// The text Zinn: Insert task pastes for the picked row: key and title, a blank line, then the description.
export const pastedText = [
  "ZINN-334: Add a sort direction to task list --sort",
  "",
  "Let callers reverse task list --sort, for example least recently active first to find tasks nobody has touched.",
].join("\n");
