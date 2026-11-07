import { TEST_ENVIRONMENT } from "../../../../scripts/test-isolation.ts";
import type { Command, ParsedRoute, RouteDef } from "../types";

import { test, expect, mock, spyOn } from "bun:test";
import { isLegacyReadAllowed, setLegacyReadAllowed } from "../lib";
import { createRouter, parseRoutes } from "./router";
import { jsonResult } from "../results";
import { getCliOpenPolicy } from "../database";
import { parsedRoutes } from "./routes";
import { commandAliases } from "./aliases";

// Metadata for commands used in routing tests.
const commandMetadata = {
  input: { options: {}, forms: [{ id: "default", positionals: [] }], constraints: [] },
  results: [jsonResult("Task")],
  summary: "",
  effects: { domain: "none", storage: "normal-open" },
  confirmation: { kind: "none" },
} satisfies Omit<Command, "run" | "help">;

const mockCommand: Command = { ...commandMetadata, run: mock(() => {}), help: `` };

test("every declared alias dispatches the canonical route and leaves argument words literal", async () => {
  for (const route of parsedRoutes) {
    const words = route.command.split(" ");
    const name = words.pop()!;
    for (const alias of commandAliases[name] ?? []) {
      const run = mock(() => {});
      const beforeRun = mock((_command: ParsedRoute) => {});
      const router = createRouter([{ ...route, run }], beforeRun);
      const args = ["rm", "show", "new", "ls", "update", "--", "--help", "--json"];
      await router.route([...words, alias, "--json", ...args]);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(args);
      expect(beforeRun).toHaveBeenCalledTimes(1);
      expect(beforeRun.mock.calls[0]![0]).toMatchObject({ command: route.command });
    }
  }
});

test("aliases preserve root and namespace help", async () => {
  const router = createRouter(parsedRoutes);
  const canonicalRouter = createRouter(parsedRoutes.map((route) => ({ ...route, aliases: [] })));
  expect(router.help).toBe(canonicalRouter.help);
  const namespaces = new Set(parsedRoutes.flatMap(({ command }) => {
    const words = command.split(" ");
    return words.slice(1).map((_, index) => words.slice(0, index + 1));
  }).map((path) => path.join(" ")));
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    for (const namespace of namespaces) {
      await router.route([...namespace.split(" "), "--help"]);
      const help = info.mock.calls.at(-1)![0];
      await canonicalRouter.route([...namespace.split(" "), "--help"]);
      expect(info.mock.calls.at(-1)![0]).toBe(help);
    }
  } finally {
    info.mockRestore();
  }
});

test("beforeRun receives the matched route after flags and completes once before the handler", async () => {
  const events: string[] = [];
  const completion = Promise.withResolvers<void>();
  const run = mock(() => { events.push("run"); });
  const beforeRun = mock(async (command: ParsedRoute) => {
    expect(command.command).toBe("foo bar");
    expect(getCliOpenPolicy().allowsLegacyRead).toBe(true);
    events.push("beforeRun");
    await completion.promise;
    events.push("ready");
  });
  const router = createRouter({ foo: { bar: { ...commandMetadata, run, help: "" } } }, beforeRun);
  try {
    const routed = router.route(["foo", "bar", "--allow-legacy-read", "value"]);
    expect(events).toEqual(["beforeRun"]);
    expect(run).not.toHaveBeenCalled();
    completion.resolve();
    await routed;
    expect(events).toEqual(["beforeRun", "ready", "run"]);
    expect(beforeRun).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(["value"]);
  } finally {
    setLegacyReadAllowed(false);
  }
});

test("help skips beforeRun", async () => {
  const beforeRun = mock(() => {});
  const run = mock(() => {});
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    await createRouter({ foo: { ...commandMetadata, run, help: "" } }, beforeRun).route(["foo", "--help"]);
    expect(beforeRun).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});

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
    `], { env: TEST_ENVIRONMENT });
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
