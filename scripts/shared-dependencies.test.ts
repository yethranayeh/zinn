import { expect, test } from "bun:test";
import core from "../packages/core/package.json";
import cli from "../packages/cli/package.json";

test("core and CLI use matching versions of shared third-party runtime dependencies", () => {
  const cliDependencies: Record<string, string> = cli.dependencies;
  for (const [name, version] of Object.entries(core.dependencies)) {
    if (Object.hasOwn(cliDependencies, name) && !version.startsWith("workspace:")) {
      expect(cliDependencies[name], `${name} must match core`).toBe(version);
    }
  }
});
