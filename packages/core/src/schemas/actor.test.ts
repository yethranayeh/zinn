import { expect, test } from "bun:test";

import { actorSchema } from "./actor";

const namedAgent = { name: "Tool@1.2", email: null, kind: "agent" as const };
const declarationFields = Object.keys(actorSchema.shape).filter(
  (field) => !["name", "email", "kind"].includes(field),
);

test("existing actors keep their shape and only agents may have no name", () => {
  expect(actorSchema.parse(namedAgent)).toEqual(namedAgent);
  expect(actorSchema.parse({ ...namedAgent, name: null }).name).toBeNull();
  expect(actorSchema.safeParse({ ...namedAgent, name: null, kind: "human" }).success).toBe(false);
  for (const name of ["", " ", undefined]) {
    expect(actorSchema.safeParse({ ...namedAgent, name }).success).toBe(false);
  }
  expect(actorSchema.safeParse({ ...namedAgent, kind: "unknown" }).success).toBe(false);
  expect(actorSchema.safeParse({ ...namedAgent, unsupported: "value" }).success).toBe(false);
});

test("actor declarations accept opaque text and null, trim edges, and reject blanks or nonstrings", () => {
  for (const field of declarationFields) {
    expect(actorSchema.parse({ ...namedAgent, [field]: "  Custom/Value  " })).toHaveProperty(field, "Custom/Value");
    expect(actorSchema.parse({ ...namedAgent, [field]: "1" })).toHaveProperty(field, "1");
    expect(actorSchema.parse({ ...namedAgent, [field]: null })).toHaveProperty(field, null);
    expect(actorSchema.parse(namedAgent)).not.toHaveProperty(field);
    for (const value of ["", " \n\t ", 1, true, {}, []]) {
      expect(actorSchema.safeParse({ ...namedAgent, [field]: value }).success).toBe(false);
    }
  }
});
