import { expect, test } from "bun:test";

import { commentCreateSchema, commentDeleteSchema, commentEditSchema } from "./comment";

test("comment schemas reject blank text without changing accepted text", () => {
  const text = "  Keep indentation\n    code  ";

  expect(commentCreateSchema.parse({ taskKey: "APP-1", text }).text).toBe(text);
  expect(commentEditSchema.parse({ commentKey: "APP-1#1", text }).text).toBe(text);

  for (const blankText of ["", "   ", "\n\t"]) {
    expect(() => commentCreateSchema.parse({ taskKey: "APP-1", text: blankText })).toThrow(
      "Comment text cannot be blank",
    );
    expect(() => commentEditSchema.parse({ commentKey: "APP-1#1", text: blankText })).toThrow(
      "Comment text cannot be blank",
    );
  }
});

test("comment schemas reject unsupported fields", () => {
  expect(() =>
    commentCreateSchema.parse({ taskKey: "APP-1", text: "Comment", actor: "someone" }),
  ).toThrow();
  expect(() => commentDeleteSchema.parse({ commentKey: "APP-1#1", text: "Comment" })).toThrow();
});
