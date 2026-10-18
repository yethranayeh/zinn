import type { Command, RouteDef } from "../types";

import { test, expect, mock, spyOn } from "bun:test";
import { isLegacyReadAllowed, setLegacyReadAllowed } from "../lib";
import { createRouter, parseRoutes } from "./router";

// Routing reads only run and help; the rest fills the Command type
const commandMetadata = {
  input: { options: {}, forms: [{ id: "default", positionals: [] }], constraints: [] },
  summary: "",
  effects: { domain: "none", storage: "normal-open" },
  confirmation: { kind: "none" },
} satisfies Omit<Command, "run" | "help">;

const mockCommand: Command = { ...commandMetadata, run: mock(() => {}), help: `` };

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

test("router waits for an asynchronous handler to finish", async () => {
  const completion = Promise.withResolvers<void>();
  let finished = false;
  const router = createRouter({ example: { ...commandMetadata, help: "", run: async () => {
    await completion.promise;
    finished = true;
  } } });

  const routed = router.route(["example"]);
  expect(finished).toBe(false);
  completion.resolve();
  await routed;
  expect(finished).toBe(true);
});

test("asynchronous handler failures use the router's JSON error boundary", () => {
  for (const errorType of ["Error", "UsageError"]) {
    const routerPath = new URL("./router.ts", import.meta.url).pathname;
    const libPath = new URL("../lib.ts", import.meta.url).pathname;
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { createRouter } from ${JSON.stringify(routerPath)};
      import { UsageError } from ${JSON.stringify(libPath)};
      const router = createRouter({ example: {
        help: "Usage: zinn example <value>\\n\\nDetails",
        run: async () => { await Promise.resolve(); throw new ${errorType}("<value>"); },
      } });
      await router.route(["example", "--json"]);
    `]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    const { error } = JSON.parse(result.stderr.toString());
    expect(error.message).toBe("<value>");
    if (errorType === "UsageError") {
      expect(error.help).toContain("zinn example <value>");
      expect(error.help).not.toContain("Details");
    } else {
      expect(error.help).toBeUndefined();
    }
  }
});

test("router calls the run functions", async () => {
  const routes: RouteDef = {
    foo: {
      create: mockCommand,
      bar: {
        create: mockCommand,
      },
    },
  };

  let router = createRouter(routes);
  await router.route(["foo", "create"]);
  expect(mockCommand.run).toHaveBeenCalledTimes(1);

  await router.route(["foo", "bar", "create"]);
  expect(mockCommand.run).toHaveBeenCalledTimes(2);
});

test("router calls the deepest nesting command", async () => {
  const fooCreate = mock(() => {});
  const barCreate = mock(() => {});
  const routes = {
    foo: {
      create: { ...commandMetadata, run: fooCreate, help: "" },
      bar: {
        create: { ...commandMetadata, run: barCreate, help: "" },
      },
    },
  } satisfies RouteDef;

  let router = createRouter(routes);
  await router.route(["foo", "bar", "create"]);
  expect(routes.foo.bar.create.run).toHaveBeenCalledTimes(1);
  expect(routes.foo.create.run).not.toHaveBeenCalled();
});

test("only arguments before the first -- are treated as router flags", async () => {
  const run = mock(() => {});
  const router = createRouter({ foo: { ...commandMetadata, run, help: "" } });

  await router.route(["foo", "--", "--json", "--help"]);
  expect(run).toHaveBeenCalledWith(["--", "--json", "--help"]);
});

test("router flags before a -- still apply", async () => {
  const run = mock(() => {});
  const router = createRouter({ foo: { ...commandMetadata, run, help: "" } });

  await router.route(["foo", "--json", "--", "literal"]);
  expect(run).toHaveBeenCalledWith(["--", "literal"]);
});

test("a help request never runs a command even when its help is empty", async () => {
  const run = mock(() => {});
  const info = spyOn(console, "info").mockImplementation(() => {});
  const router = createRouter({ foo: { ...commandMetadata, run, help: "" } });

  try {
    await router.route(["foo", "--help"]);
    expect(run).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("");
  } finally {
    info.mockRestore();
  }
});

test("a help flag anywhere before -- prints help for the words before it and runs nothing", async () => {
  const run = mock(() => {});
  const info = spyOn(console, "info").mockImplementation(() => {});
  const router = createRouter({ foo: { bar: { ...commandMetadata, run, help: "bar help" } } });

  try {
    await router.route(["foo", "bar", "--help", "--name", "x"]);
    await router.route(["foo", "bar", "x", "-h"]);
    expect(run).not.toHaveBeenCalled();
    expect(info.mock.calls).toEqual([["bar help"], ["bar help"]]);

    await router.route(["foo", "--help", "bar"]);
    expect(info.mock.calls.at(-1)![0]).toContain("Usage: zinn foo <command>");
  } finally {
    info.mockRestore();
  }
});

test("--allow-legacy-read before a -- is taken out of the arguments and allows legacy reads", async () => {
  const run = mock(() => {});
  const router = createRouter({ foo: { ...commandMetadata, run, help: "" } });

  try {
    await router.route(["foo", "--allow-legacy-read", "--", "literal"]);
    expect(run).toHaveBeenCalledWith(["--", "literal"]);
    expect(isLegacyReadAllowed()).toBe(true);
  } finally {
    setLegacyReadAllowed(false);
  }
});

test("--allow-legacy-read after a -- stays command input and allows nothing", async () => {
  const run = mock(() => {});
  const router = createRouter({ foo: { ...commandMetadata, run, help: "" } });

  await router.route(["foo", "--", "--allow-legacy-read"]);
  expect(run).toHaveBeenCalledWith(["--", "--allow-legacy-read"]);
  expect(isLegacyReadAllowed()).toBe(false);
});
