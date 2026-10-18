import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withDirectory } from "../../core/src/migrations/testing.js";
import { runCli } from "../testing.js";
import { routes } from "./routes/routes.js";
import { parseRoutes } from "./routes/router.js";
import {
  generateCommandUsage,
  getOptionInputs,
  violatesConstraint,
  type CommandInput,
} from "./input.js";

const commands = parseRoutes(routes);

test("every runnable route declares its inputs, effects, confirmation and generated syntax", () => {
  for (const command of commands) {
    const input = command.input;
    expect(input, command.command).toBeDefined();
    expect(input.forms.length).toBeGreaterThan(0);
    expect(command.summary?.length).toBeGreaterThan(0);
    expect(command.effects).toBeDefined();
    expect(command.confirmation).toBeDefined();
    expect(command.help.startsWith(generateCommandUsage(command.command, input))).toBe(true);
    const formIds = input.forms.map((form) => form.id);
    expect(new Set(formIds).size).toBe(formIds.length);
    for (const form of input.forms) {
      const inputs = new Set([
        ...Object.keys(input.options).map((name) => `option:${name}`),
        ...form.positionals.map(({ name }) => `positional:${name}`),
      ]);
      for (const constraint of input.constraints) {
        const references =
          constraint.kind === "requires"
            ? [constraint.input, constraint.requires]
            : constraint.members;
        for (const reference of references) {
          expect(inputs.has(reference), `${command.command}: ${reference}`).toBe(true);
        }
      }
      for (const positional of form.positionals) {
        expect(positional.min).toBeGreaterThanOrEqual(0);
        expect(positional.max === null || positional.max >= positional.min).toBe(true);
        expect(positional.value.kind.length).toBeGreaterThan(0);
      }
    }
    for (const option of Object.values(input.options)) {
      if (option.type === "string") {
        expect(option.value, command.command).toBeDefined();
      }
    }
  }
  expect(() =>
    JSON.stringify(
      commands.map(({ input, effects, confirmation }) => ({ input, effects, confirmation })),
    ),
  ).not.toThrow();
});

test("every declared singular option rejects repetition before storage access", () => {
  withDirectory((directory) => {
    const env = { ...process.env, ZINN_DIR: directory };
    for (const command of commands) {
      for (const [name, option] of Object.entries(command.input.options)) {
        if (option.multiple) {
          continue;
        }
        const flag = option.type === "string" ? `--${name}=value` : `--${name}`;
        const result = runCli([...command.command.split(" "), flag, flag, "--json"], { env });
        expect(result.code, `${command.command}: ${name}`).toBe(1);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr).error).toMatchObject({
          code: "invalid_input",
          details: { argument: `--${name}` },
        });
      }
    }
    expect(existsSync(join(directory, "data"))).toBe(false);
  });
});

test("every positional form rejects missing and excess words before storage access", () => {
  withDirectory((directory) => {
    const env = { ...process.env, ZINN_DIR: directory };
    for (const command of commands) {
      for (const form of command.input.forms) {
        const words = form.positionals.map(
          (positional) => positional.value.choices?.[0] ?? "value",
        );
        const requiredCount = form.positionals.reduce(
          (count, positional) => count + positional.min,
          0,
        );
        const scenarios: string[][] = [];
        if (requiredCount > 0) {
          scenarios.push(words.slice(0, requiredCount - 1));
        }
        if (!form.positionals.some((positional) => positional.max === null)) {
          scenarios.push([...words, "excess"]);
        }
        for (const positionals of scenarios) {
          const result = runCli([...command.command.split(" "), "--json", "--", ...positionals], {
            env,
          });
          expect(result.code, `${command.command}: ${form.id}`).toBe(1);
          expect(result.stdout).toBe("");
          expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
        }
      }
    }
    expect(existsSync(join(directory, "data"))).toBe(false);
  });
});

test("structural presence retains empty text and treats false flags as absent", () => {
  const text = routes.task.edit.input.constraints.find(
    (constraint) => constraint.kind === "atLeastOne",
  )!;
  expect(violatesConstraint(text, getOptionInputs({ description: "" }))).toBe(false);
  expect(violatesConstraint(text, getOptionInputs({}))).toBe(true);
  const all = routes.task.edit.input.constraints.find(
    (constraint) => constraint.kind === "requires" && constraint.input === "option:all",
  )!;
  expect(violatesConstraint(all, getOptionInputs({ all: false }))).toBe(false);
  expect(violatesConstraint(all, getOptionInputs({ all: true }))).toBe(true);
  expect(violatesConstraint(all, getOptionInputs({ all: true, replacing: "" }))).toBe(false);
});

type SuppliedValues = Record<string, string | string[] | boolean>;

function declaredArgv(
  path: string,
  positionalValues: SuppliedValues = {},
  optionValues: SuppliedValues = {},
  formId?: string,
) {
  const command = commands.find((candidate) => candidate.command === path)!;
  const input: CommandInput = command.input;
  const form =
    formId === undefined
      ? input.forms[0]!
      : input.forms.find((candidate) => candidate.id === formId)!;
  const argv = path.split(" ");
  for (const [name, option] of Object.entries(input.options)) {
    const supplied = optionValues[name];
    if (supplied === undefined || supplied === false) {
      continue;
    }
    for (const value of Array.isArray(supplied) ? supplied : [supplied]) {
      argv.push(option.type === "boolean" ? `--${name}` : `--${name}=${value}`);
    }
  }
  argv.push("--json");
  const words = form.positionals.flatMap(({ name }) => {
    const supplied = positionalValues[name];
    return supplied === undefined ? [] : Array.isArray(supplied) ? supplied : [String(supplied)];
  });
  if (words.length > 0) {
    argv.push("--", ...words);
  }
  return argv;
}

test("declared forms construct list, history, repeated-key move and both order invocations", () => {
  withDirectory((directory) => {
    const env = { ...process.env, ZINN_DIR: directory };
    const invoke = (
      path: string,
      positionals: SuppliedValues = {},
      options: SuppliedValues = {},
      form?: string,
    ) => {
      const result = runCli(declaredArgv(path, positionals, options, form), { env });
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    invoke("project create", { "project-key": "DECL" });
    expect(invoke("task list", { "project-key": "DECL" })).toEqual([]);
    const columns = invoke("project column list", { "project-key": "DECL" });
    const first = invoke(
      "task create",
      { "project-key": "DECL" },
      { title: "--help", priority: "HIGH" },
    );
    const second = invoke("task create", { "project-key": "DECL" }, { title: "Second task" });
    expect(first.title).toBe("--help");
    expect(first.priority).toBe("high");
    expect(invoke("task list", { "project-key": "DECL" })).toHaveLength(2);
    expect(invoke("task view", { "task-key": first.key })).not.toHaveProperty("activity");
    expect(
      Array.isArray(invoke("task view", { "task-key": first.key }, { history: true }).activity),
    ).toBe(true);
    const moved = invoke("task move", {
      "task-key": [first.key, first.key],
      "target-column": columns[1].name,
    });
    expect(moved).toHaveLength(2);
    expect(moved.map((entry: { key: string }) => entry.key)).toEqual([first.key, first.key]);
    expect(
      invoke("task move", { "task-key": first.key, "target-column": columns[1].name }).changed,
    ).toBe(false);
    invoke("task move", { "task-key": second.key, "target-column": columns[1].name });
    const orderForms = routes.task.order.input.forms;
    const absolute = orderForms[0];
    const relative = orderForms[1];
    expect(
      invoke(
        "task order",
        {
          "task-key": first.key,
          direction: absolute.positionals[1].value.choices[0],
        },
        {},
        absolute.id,
      ).key,
    ).toBe(first.key);
    expect(
      invoke(
        "task order",
        {
          "task-key": second.key,
          direction: relative.positionals[1].value.choices[0],
          "target-task-key": first.key,
        },
        {},
        relative.id,
      ).key,
    ).toBe(second.key);
  });
});

test("project resolution and order errors retain their validation precedence", () => {
  withDirectory((directory) => {
    const env = { ...process.env, ZINN_DIR: directory };
    const project = runCli(["project", "edit", "--append", "--json"], { env });
    expect(JSON.parse(project.stderr).error.details.argument).toBe("project-key");
    for (const path of ["task order", "project column order"]) {
      const positionals = path === "task order" ? ["DECL-1"] : ["DECL", "TODO"];
      const result = runCli([...path.split(" "), ...positionals, "sideways", "extra", "--json"], {
        env,
      });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).error).toMatchObject({
        code: "invalid_input",
        details: { argument: "direction" },
      });
      expect(JSON.parse(result.stderr).error.help).toContain(path);
    }
    expect(existsSync(join(directory, "data"))).toBe(false);
  });
});
