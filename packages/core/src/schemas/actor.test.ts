import { expect, test } from "bun:test";

import { actorSchema, parseClientChain } from "./actor";

const namedAgent = { name: "Tool@1.2", email: null, kind: "agent" as const };
const declarationFields = Object.keys(actorSchema.shape).filter(
  (field) => !["name", "email", "kind", "client"].includes(field),
);

test.each([null, "", " \n\t\r\u00a0 "])("an empty client chain %j has no tokens", (client) => {
  expect(parseClientChain(client)).toEqual([]);
});

test("client parsing preserves token order, case, versions and repeated clients across whitespace", () => {
  expect(parseClientChain("  zinn-cli/0.44.0\trex/0.9\nzinn-opencode:panel/0.3.0\u00a0Custom/2  rex/0.9 ")).toEqual([
    { name: "zinn-cli", version: "0.44.0" },
    { name: "rex", version: "0.9" },
    { name: "zinn-opencode:panel", version: "0.3.0" },
    { name: "Custom", version: "2" },
    { name: "rex", version: "0.9" },
  ]);
});

test("client parsing accepts arbitrary tokens and separates only the first slash", () => {
  expect(parseClientChain("wrapper (panel ui) custom/1/2 tool/ /1 /")).toEqual([
    { name: "wrapper", version: null },
    { name: "(panel", version: null },
    { name: "ui)", version: null },
    { name: "custom", version: "1/2" },
    { name: "tool", version: "" },
    { name: "", version: "1" },
    { name: "", version: "" },
  ]);
});

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

test("client declarations preserve arbitrary strings and allow null or omission", () => {
  for (const client of ["", " \n\t ", "  wrapper/1  (panel ui)\tother/2  ", "Custom/Value"]) {
    expect(actorSchema.parse({ ...namedAgent, client }).client).toBe(client);
  }
  expect(actorSchema.parse({ ...namedAgent, client: null }).client).toBeNull();
  expect(actorSchema.parse(namedAgent)).not.toHaveProperty("client");
  expect(actorSchema.safeParse({ ...namedAgent, client: 1 }).success).toBe(false);
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
