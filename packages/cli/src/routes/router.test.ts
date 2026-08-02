import type { Command, RouteDef } from "../types";

import { test, expect, mock } from "bun:test";
import { createRouter, parseRoutes } from "./router";

const mockCommand: Command = { run: mock(() => {}), help: `` };

test("command nesting is properly parsed", () => {
  const routes: RouteDef = {
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

test("router calls the run functions", () => {
  const routes: RouteDef = {
    foo: {
      create: mockCommand,
      bar: {
        create: mockCommand,
      },
    },
  };

  let router = createRouter(routes);
  router.route(["foo", "create"]);
  expect(mockCommand.run).toHaveBeenCalledTimes(1);

  router.route(["foo", "bar", "create"]);
  expect(mockCommand.run).toHaveBeenCalledTimes(2);
});

test("router calls the deepest nesting command", () => {
  const fooCreate = mock(() => {});
  const barCreate = mock(() => {});
  const routes = {
    foo: {
      create: { run: fooCreate, help: "" },
      bar: {
        create: { run: barCreate, help: "" },
      },
    },
  } satisfies RouteDef;

  let router = createRouter(routes);
  router.route(["foo", "bar", "create"]);
  expect(routes.foo.bar.create.run).toHaveBeenCalledTimes(1);
  expect(routes.foo.create.run).not.toHaveBeenCalled();
});
