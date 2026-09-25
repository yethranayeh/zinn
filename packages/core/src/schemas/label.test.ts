import { expect, test } from "bun:test";

import { labelEditSchema } from "./label";

test("label edits require a valid supplied field and normalize names", () => {
  expect(labelEditSchema.parse({ labelName: " bug ", name: " defect " })).toEqual({
    labelName: "bug",
    name: "defect",
  });
  expect(labelEditSchema.parse({ labelName: "bug", description: "" })).toEqual({
    labelName: "bug",
    description: "",
  });

  for (const input of [
    { labelName: "bug" },
    { labelName: "bug", name: " " },
    { labelName: "bug", color: "purple" },
    { labelName: "bug", description: 42 },
    { labelName: "bug", description: "Valid", unsupported: true },
  ]) {
    expect(labelEditSchema.safeParse(input).success).toBe(false);
  }
});
