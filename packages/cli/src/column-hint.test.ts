import { expect, spyOn, test } from "bun:test";
import { column } from "@zinn-dev/core";
import { quotedColumnHint } from "./column-hint";
import { CliError } from "./errors";
import { UsageError } from "./lib";
import { parsedRoutes } from "./routes/routes";
import { createRouter } from "./routes/router";

test("successful column commands do not inspect diagnostic context", async () => {
  const inspection = spyOn(column, "inspect").mockImplementation(() => {
    throw new Error("unexpected inspection");
  });
  try {
    const columnRoutes = parsedRoutes.filter(route => route.input.options.column?.value?.kind === "column-name" ||
      route.input.forms.some(form => form.positionals.some(input => input.value.kind === "column-name")));
    expect(columnRoutes.length).toBeGreaterThan(0);
    for (const route of columnRoutes) {
      const router = createRouter([{ ...route, run: () => undefined }]);
      await router.route(route.command.split(" "));
    }
    expect(inspection).not.toHaveBeenCalled();
  } finally {
    inspection.mockRestore();
  }
});

test("unrelated parse failures avoid inspection and an unavailable lookup cannot replace a usage error", () => {
  const route = parsedRoutes.find(entry => entry.command === "project column edit")!;
  const args = ["project", "column", "edit", "SHOP", "In", "Progress", "--name", "Working"];
  const inspection = spyOn(column, "inspect").mockImplementation(() => {
    throw new Error("inspection unavailable");
  });
  try {
    expect(quotedColumnHint(new CliError("Unknown option", "invalid_input", { argument: "--bogus" }), route, args, 3)).toBeUndefined();
    expect(inspection).not.toHaveBeenCalled();
    const failure = new UsageError("Unexpected argument Progress", { field: [] });
    expect(quotedColumnHint(failure, route, args, 3)).toBeUndefined();
    expect(inspection).toHaveBeenCalledTimes(1);
    expect(failure.details).toEqual({ field: [] });
  } finally {
    inspection.mockRestore();
  }
});
