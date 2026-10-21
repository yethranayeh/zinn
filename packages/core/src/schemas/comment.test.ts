import { expect, test } from "bun:test";

import { commentCreateSchema, commentDeleteSchema, commentEditSchema } from "./comment";

test("comment schemas reject blank text without changing accepted text", () => {
  const text = "  Keep indentation\n    code  ";

  expect(commentCreateSchema.parse({ taskKey: "APP-1", text }).text).toBe(text);
  expect(commentEditSchema.parse({ commentKey: "APP-1#1", text }).text).toBe(text);

  for (const blankText of ["", "   ", "\n\t"]) {
    expect(commentCreateSchema.safeParse({ taskKey: "APP-1", text: blankText }).error?.issues)
      .toMatchObject([{ path: ["text"] }]);
    expect(commentEditSchema.safeParse({ commentKey: "APP-1#1", text: blankText }).error?.issues)
      .toMatchObject([{ path: ["text"] }]);
  }
});

test("comment schemas reject unsupported fields", () => {
  expect(() =>
    commentCreateSchema.parse({ taskKey: "APP-1", text: "Comment", actor: "someone" }),
  ).toThrow();
  expect(() => commentDeleteSchema.parse({ commentKey: "APP-1#1", text: "Comment" })).toThrow();
});

test("comment creation and editing normalize only CRLF pairs", () => {
  for (const [text, normalized] of [
    ["Plain text", "Plain text"],
    ["  First\r\n\tSecond\nThird\rFourth  \r\n", "  First\n\tSecond\nThird\rFourth  \n"],
  ] as const) {
    expect(commentCreateSchema.parse({ taskKey: "APP-1", text }).text).toBe(normalized);
    expect(commentEditSchema.parse({ commentKey: "APP-1#1", text }).text).toBe(normalized);
  }
});
