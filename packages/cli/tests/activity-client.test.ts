import { expect, test } from "bun:test";
import type { Activity } from "@zinn-dev/core";

import packageJson from "../package.json";
import { resultSchemas } from "../src/result-schemas";
import { runZinn, withIsolatedZinnDir } from "../test-helpers";

test("CLI writes, whoami, activity JSON and text carry the client chain and support filtered continuation", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const ownClient = `zinn-cli/${packageJson.version}`;
    const run = async (args: string[], client?: string) => {
      const result = await runZinn(args, directory, client === undefined ? {} : { ZINN_CLIENT: client });
      expect(result.code, result.stderr).toBe(0);
      return result;
    };
    const list = async (...flags: string[]): Promise<Activity[]> => {
      const result = await run(["activity", "list", ...flags, "--json"]);
      return resultSchemas.ActivityList.parse(JSON.parse(result.stdout)) as Activity[];
    };
    await run(["project", "create", "APP"]);
    const declarations = [undefined, "", " \t ", "  rex/0.9 zinn-opencode:panel/0.3.0  ", "zinn-opencode/0.4.0"];
    for (const [index, declaration] of declarations.entries()) {
      const expected = declaration?.trim() ? `${ownClient} ${declaration.trim()}` : ownClient;
      await run(["task", "create", "APP", "--title", `Item ${index}`], declaration);
      const [event] = await list("--task", `APP-${index + 1}`);
      expect(event!.actor_client).toBe(expected);
      const identity = await run(["whoami", "--json"], declaration);
      expect(resultSchemas.Actor.parse(JSON.parse(identity.stdout)).actor_client).toBe(expected);
      const detail = await run(["activity", "view", event!.id, "--json"]);
      expect(resultSchemas.Activity.parse(JSON.parse(detail.stdout))).toEqual(event!);
      for (const args of [["whoami"], ["activity", "list", "--task", `APP-${index + 1}`], ["activity", "view", event!.id]]) {
        expect((await run(args, declaration)).stdout).toContain(expected);
      }
    }
    const matches = await list("--client", "zinn-opencode");
    expect(matches).toHaveLength(2);
    expect(await list("--client", "zinn-opencode:panel")).toEqual([matches[1]!]);
    for (const name of ["zinn", "Zinn-opencode", "zinn-opencode/0.4.0"]) {
      expect(await list("--client", name)).toEqual([]);
    }
    const firstPage = await run(["activity", "list", "--client", "zinn-opencode", "--limit", "1", "--json"]);
    expect(JSON.parse(firstPage.stdout)).toEqual([matches[0]!]);
    for (const fact of ["--client", "zinn-opencode", "--starting-after", matches[0]!.id, "--json"]) {
      expect(firstPage.stderr).toContain(fact);
    }
    expect(await list("--client", "zinn-opencode", "--limit", "1", "--starting-after", matches[0]!.id)).toEqual([matches[1]!]);
  });
});
