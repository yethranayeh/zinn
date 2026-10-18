import type { Capabilities } from "./src/capabilities";

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";

import { runCli } from "./testing";

export function inventory(directory: string): unknown {
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const content = stat.isSymbolicLink()
        ? readlinkSync(path)
        : stat.isDirectory()
          ? inventory(path)
          : createHash("sha256").update(readFileSync(path)).digest("hex");
      return { name, mode: stat.mode, modified: stat.mtimeMs, content };
    });
}

export function capabilityValidator(manifest: Capabilities) {
  const ajv = new Ajv({ strict: true, allowUnionTypes: true });
  ajv.addSchema(manifest.schemas, "results");
  for (const name of Object.keys(manifest.schemas.definitions)) {
    assert.ok(ajv.getSchema(`results#/definitions/${name}`), `Unusable schema ${name}`);
  }
  const validate = ajv.getSchema("results#/definitions/Capabilities")!;
  assert.ok(validate(manifest), JSON.stringify(validate.errors));
  function reference(value: unknown): void {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" || (key === "schemaRef" && typeof child === "string")) {
        assert.equal(typeof child, "string");
        assert.ok((child as string).startsWith("#/"));
        const root = key === "$ref" ? manifest.schemas : manifest;
        const target = (child as string)
          .slice(2)
          .split("/")
          .reduce<unknown>(
            (node, part) =>
              (node as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")],
            root,
          );
        assert.notEqual(target, undefined, `Unresolved reference ${child}`);
      } else {
        reference(child);
      }
    }
  }
  reference(manifest);
  return ajv;
}

/** Checks source, built or installed discovery in a disposable directory. */
export function checkCapabilityDiscovery(options: {
  runtime: string;
  entryPoint: string;
  packageDirectory: string;
  directory: string;
  env: Record<string, string | undefined>;
  expected?: Capabilities;
}): Capabilities {
  const { directory } = options;
  const home = join(directory, "home");
  mkdirSync(join(home, ".zinn"), { recursive: true });
  writeFileSync(join(home, ".zinn/settings.json"), "{");
  writeFileSync(join(directory, "zinn.local.json"), "{");
  const unavailableStore = join(directory, "unavailable-store");
  writeFileSync(unavailableStore, "a file cannot contain a database directory");
  const guard = join(directory, "discovery-guard.mjs");
  copyFileSync(new URL("./discovery-guard.mjs", import.meta.url), guard);
  const before = inventory(directory);
  const env = {
    ...options.env,
    HOME: home,
    ZINN_DIR: unavailableStore,
    FORCE_COLOR: "1",
    ZINN_DEBUG: "1",
    DEBUG: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  const discovered = runCli(["capabilities", "--json"], {
    runtime: options.runtime,
    cliPath: options.entryPoint,
    cwd: directory,
    env,
  });
  assert.equal(discovered.code, 0, discovered.stderr);
  const manifest: Capabilities = JSON.parse(discovered.stdout);
  const intercepted = runCli([options.entryPoint, "capabilities", "--json"], {
    runtime: options.runtime,
    cliPath: guard,
    cwd: directory,
    env,
  });
  assert.equal(intercepted.code, 0, intercepted.stderr);
  assert.deepEqual(JSON.parse(intercepted.stdout), manifest);
  const identity = JSON.parse(readFileSync(join(options.packageDirectory, "package.json"), "utf8"));
  assert.deepEqual(manifest.cli, { name: identity.name, version: identity.version });
  capabilityValidator(manifest);
  assert.ok(manifest.commands.some(({ path }) => path.join(" ") === "capabilities"));
  assert.deepEqual(inventory(directory), before);
  if (options.expected) {
    const { cli: expectedIdentity, ...expected } = options.expected;
    const { cli: actualIdentity, ...actual } = manifest;
    assert.deepEqual(actual, expected);
  }
  return manifest;
}

/** A consumer builds argv and selects result schemas from the emitted descriptors. */
export function capabilityConsumer(
  manifest: Capabilities,
  invoke: (args: string[]) => ReturnType<typeof runCli>,
) {
  const ajv = capabilityValidator(manifest);
  return (
    path: string[],
    positionals: Record<string, string | string[]> = {},
    options: Record<string, string | string[] | boolean> = {},
  ) => {
    const command = manifest.commands.find((command) => command.path.join(" ") === path.join(" "));
    assert.ok(command, `Unknown command ${path.join(" ")}`);
    const supplied = (name: string) => {
      const value = positionals[name];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    };
    const form = command.input.forms.find(
      (form) =>
        Object.keys(positionals).every((name) =>
          form.positionals.some((item) => item.name === name),
        ) &&
        form.positionals.every((item) => {
          const values = supplied(item.name);
          return (
            values.length >= item.min &&
            (item.max === null || values.length <= item.max) &&
            (item.value.choices === undefined ||
              values.every((value) => item.value.choices!.includes(value)))
          );
        }),
    );
    assert.ok(form, "No matching positional form");
    const args = [...command.path];
    for (const [name, value] of Object.entries(options)) {
      const option = command.input.options[name];
      assert.ok(option, `Unknown option ${name}`);
      if (option.type === "boolean") {
        assert.equal(typeof value, "boolean");
        if (value) {
          args.push(`--${name}`);
        }
      } else {
        const values = Array.isArray(value) ? value : [value];
        assert.ok(option.multiple || values.length === 1);
        for (const value of values) {
          assert.equal(typeof value, "string");
          args.push(`--${name}=${value}`);
        }
      }
    }
    assert.equal(manifest.invocation.routerOptions.json.type, "boolean");
    args.push("--json");
    const words = form.positionals.flatMap((item) => supplied(item.name));
    if (words.length > 0) {
      args.push(manifest.invocation.optionSeparator, ...words);
    }
    const selected = command.results.filter(({ selector }) => {
      if (selector.kind === "always") {
        return true;
      }
      if (selector.kind === "booleanOption") {
        return (options[selector.name] === true) === selector.value;
      }
      const count = supplied(selector.name).length;
      return count >= selector.min && (selector.max === null || count <= selector.max);
    });
    assert.equal(selected.length, 1);
    const result = invoke(args);
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    const validate = ajv.getSchema(`results#${selected[0]!.schemaRef.slice("#/schemas".length)}`)!;
    assert.ok(validate(value), JSON.stringify(validate.errors));
    return value;
  };
}

export function checkCapabilityConsumer(
  manifest: Capabilities,
  invoke: (args: string[]) => ReturnType<typeof runCli>,
) {
  const consume = capabilityConsumer(manifest, invoke);
  consume(["project", "create"], { "project-key": "CAP" });
  assert.deepEqual(consume(["task", "list"], { "project-key": "CAP" }), []);
  const first = consume(["task", "create"], { "project-key": "CAP" }, { title: "--literal title" });
  const second = consume(["task", "create"], { "project-key": "CAP" }, { title: "Second task" });
  assert.equal(consume(["task", "list"], { "project-key": "CAP" }).length, 2);
  const detail = consume(["task", "view"], { "task-key": first.key });
  assert.equal(Object.hasOwn(detail, "activity"), false);
  const history = consume(["task", "view"], { "task-key": first.key }, { history: true });
  assert.ok(history.activity.length > 0);
  consume(["project", "column", "create"], {
    "project-key": "CAP",
    "column-name": "--destination",
  });
  const single = consume(["task", "move"], {
    "task-key": first.key,
    "target-column": "--destination",
  });
  assert.equal(single.changed, true);
  const bulk = consume(["task", "move"], {
    "task-key": [first.key, second.key],
    "target-column": "--destination",
  });
  assert.deepEqual(
    bulk.map((task: { changed: boolean }) => task.changed),
    [false, true],
  );
  const duplicates = consume(["task", "move"], {
    "task-key": [first.key, first.key],
    "target-column": "--destination",
  });
  assert.equal(duplicates.length, 2);
  consume(["task", "order"], { "task-key": first.key, direction: "bottom" });
  consume(["task", "order"], {
    "task-key": first.key,
    direction: "before",
    "target-task-key": second.key,
  });
}
