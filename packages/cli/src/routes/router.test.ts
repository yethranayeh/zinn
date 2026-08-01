import { test, expect } from "bun:test";
import { parseRoutes } from "./router";
import type { Command } from "../types";

const mockCommand: Command = { run: () => {}, help: `` };

test("command nesting is properly parsed", () => {
  const routes = {
    foo: {
      create: mockCommand,
      bar: {
        create: mockCommand,
        baz: {
          create: mockCommand,
          foo: {
            create: mockCommand,
          },
        },
      },
    },
  };
  expect(parseRoutes(routes).map((r) => r.command)).toEqual([
    "foo create",
    "foo bar create",
    "foo bar baz create",
    "foo bar baz foo create",
  ]);
});
