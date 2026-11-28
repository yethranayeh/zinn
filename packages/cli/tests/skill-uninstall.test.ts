import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, stubNpx, withIsolatedZinnDir } from "../test-helpers";

const npxArgs = (argsPath: string) => readFileSync(argsPath, "utf8").trimEnd().split("\n");

test("skill uninstall removes the zinn skill globally through the skills CLI and passes its output through", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const stub = stubNpx(dir);
    const result = await runZinn(["skill", "uninstall"], dir, stub.env);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("stub npx ran");
    expect(npxArgs(stub.argsPath)).toEqual(["--yes", "skills", "remove", "zinn", "-g", "-y"]);
  });
});

test("skill uninstall --project removes the copy in the caller's working directory without -g", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const stub = stubNpx(dir);
    const result = await runZinn(["skill", "uninstall", "--project"], dir, stub.env);

    expect(result.code, result.stderr).toBe(0);
    expect(npxArgs(stub.argsPath)).toEqual(["--yes", "skills", "remove", "zinn", "-y"]);
    expect(readFileSync(stub.cwdPath, "utf8").trimEnd()).toBe(realpathSync(dir));
  });
});

test("skill uninstall --json keeps stdout for the result and reports the skills CLI output as notices", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const stub = stubNpx(dir);

    for (const args of [["--json"], ["--project", "--json"]]) {
      const result = await runZinn(["skill", "uninstall", ...args], dir, stub.env);

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ name: "zinn" });
      expect(result.stderr).toContain("stub npx ran");
    }
  });
});

test("skill uninstall exits with the skills CLI's exit code when it fails", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const stub = stubNpx(dir);
    const failingExitCode = "3";
    const env = { ...stub.env, STUB_NPX_EXIT: failingExitCode };

    const text = await runZinn(["skill", "uninstall"], dir, env);
    expect(text.code).toBe(3);
    expect(text.stdout).toContain("stub npx ran");

    const json = await runZinn(["skill", "uninstall", "--json"], dir, env);
    expect(json.code).toBe(3);
    expect(json.stdout).toBe("");
    const { error } = errorDocumentSchema.parse(JSON.parse(json.stderr));
    expect(error.details).toMatchObject({ exitCode: 3 });
    expect(error.details).not.toHaveProperty("path");
    expect(error.diagnostics).toContain("stub npx ran");
  });
});
