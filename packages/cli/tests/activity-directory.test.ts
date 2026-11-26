import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { resultSchemas } from "../src/result-schemas";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir } from "../test-helpers";

test("CLI writes record the directory they ran in, and telemetry records leave it out", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const nested = join(directory, "work", "nested");
    mkdirSync(nested, { recursive: true });
    const env = { ...TEST_ENVIRONMENT, ZINN_DIR: directory };
    const runIn = async (cwd: string, args: string[]) => {
      const result = await runProcessAsync([process.execPath, CLI_PATH, ...args], { cwd, env });
      expect(result.code, result.stderr).toBe(0);
      return result;
    };
    const expected = realpathSync(nested);

    await runIn(nested, ["project", "create", "APP"]);
    await runIn(nested, ["task", "create", "APP", "--title", "One"]);
    const events = resultSchemas.ActivityList.parse(JSON.parse((await runZinn(["activity", "list", "--json"], directory)).stdout));
    expect(events.map((event) => event.actor_directory)).toEqual(events.map(() => expected));
    const identity = resultSchemas.Actor.parse(JSON.parse((await runIn(nested, ["whoami", "--json"])).stdout));
    expect(identity.actor_directory).toBe(expected);
    const blame = JSON.parse((await runZinn(["task", "blame", "APP-1", "--json"], directory)).stdout);
    expect(blame.fields.title.attribution.actor_directory).toBe(expected);
    expect((await runZinn(["activity", "view", events[0]!.id], directory)).stdout).toContain(expected);

    const telemetry = join(directory, "telemetry");
    const records = readdirSync(telemetry).map((name) => readFileSync(join(telemetry, name), "utf8").replaceAll("\0", ""));
    expect(records.join("")).toContain('"route"');
    for (const record of records) {
      expect(record).not.toContain(expected);
    }
  });
});
