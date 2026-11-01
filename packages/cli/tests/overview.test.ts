import { expect, test } from "bun:test";

import { overview } from "../src/overview";
import { parsedRoutes } from "../src/routes/routes";
import { runZinn, withIsolatedZinnDir } from "../test-helpers";

test("every command and flag named in the help overview exists in the route table", () => {
  const uses = overview.flatMap(({ uses }) => uses);
  expect(uses.length).toBeGreaterThan(0);

  for (const { command, flags = [] } of uses) {
    const route = parsedRoutes.find((candidate) => candidate.command === command);
    expect(route, command).toBeDefined();

    for (const flag of flags) {
      const [flagName] = flag.split(" ");
      expect(flagName!.startsWith("--"), flag).toBe(true);
      expect(Object.keys(route!.input.options), `${command} ${flag}`).toContain(flagName!.slice(2));
    }
  }
});

test("the root help names every command and flag in the overview", async () => {
  await withIsolatedZinnDir(async directory => {
    const { code, stdout } = await runZinn(["--help"], directory);
    expect(code).toBe(0);

    for (const { command, flags = [] } of overview.flatMap(({ uses }) => uses)) {
      expect(stdout).toContain(command);
      for (const flag of flags) {
        expect(stdout).toContain(flag);
      }
    }
  });
});
