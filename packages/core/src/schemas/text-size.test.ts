import { expect, test } from "bun:test";

import { MAX_TEXT_BYTES } from "../../index";
import { projectCreateSchema, projectEditSchema } from "./project";
import { taskCreateSchema, taskEditSchema } from "./task";
import { labelCreateSchema, labelEditSchema } from "./label";
import { commentCreateSchema, commentEditSchema } from "./comment";

const inputs = [
  { schema: projectCreateSchema, input: { key: "APP" }, field: "description" },
  { schema: projectEditSchema, input: { projectKey: "APP" }, field: "description" },
  { schema: taskCreateSchema, input: { project_id: "id", title: "Task" }, field: "description" },
  { schema: taskEditSchema, input: { taskKey: "APP-1" }, field: "description" },
  { schema: labelCreateSchema, input: { name: "bug" }, field: "description" },
  { schema: labelEditSchema, input: { labelName: "bug" }, field: "description" },
  { schema: commentCreateSchema, input: { taskKey: "APP-1" }, field: "text" },
  { schema: commentEditSchema, input: { commentKey: "APP-1#1" }, field: "text" },
] as const;

test("full text accepts the UTF-8 byte limit and rejects one byte over for every text field", () => {
  const emojiBytes = 4;
  const atLimit = "a".repeat(MAX_TEXT_BYTES - emojiBytes) + "😀";
  expect(Buffer.byteLength(atLimit, "utf8")).toBe(MAX_TEXT_BYTES);
  for (const { schema, input, field } of inputs) {
    expect(schema.safeParse({ ...input, [field]: atLimit }).success).toBe(true);
    const rejected = schema.safeParse({ ...input, [field]: atLimit + "a" });
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error.issues[0]?.message).toContain(String(MAX_TEXT_BYTES + 1));
      expect(rejected.error.issues[0]?.message).toContain(String(MAX_TEXT_BYTES));
    }
  }
});

test("full text is capped before CRLF or blank-description normalization", () => {
  const crlfText = "x" + "\r\n".repeat(MAX_TEXT_BYTES / 2);
  expect(Buffer.byteLength(crlfText.replaceAll("\r\n", "\n"))).toBeLessThan(MAX_TEXT_BYTES);
  for (const { schema, input, field } of inputs) {
    expect(schema.safeParse({ ...input, [field]: crlfText }).success).toBe(false);
    if (field === "description") {
      expect(schema.safeParse({ ...input, [field]: " ".repeat(MAX_TEXT_BYTES + 1) }).success).toBe(false);
    }
  }
});
