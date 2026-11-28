import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, stubNpx, withIsolatedZinnDir } from "../test-helpers";

const npxArgs = (argsPath: string) => readFileSync(argsPath, "utf8").trimEnd().split("\n");

test("skill install hands the bundled skill folder to the skills CLI and passes its output through", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const stub = stubNpx(dir);
    const result = await runZinn(["skill", "install"], dir, stub.env);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("stub npx ran");
    const args = npxArgs(stub.argsPath);
    expect(args).toEqual(["--yes", "skills", "add", args[3]!, "-g", "-y"]);
    expect(existsSync(join(args[3]!, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(args[3]!, "SKILL.md"), "utf8")).toBe(
      readFileSync(join(import.meta.dir, "../skills/zinn/SKILL.md"), "utf8"),
    );
  });
});

test("skill install --project installs into the caller's working directory without -g", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const stub = stubNpx(dir);
    const result = await runZinn(["skill", "install", "--project"], dir, stub.env);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("stub npx ran");
    const args = npxArgs(stub.argsPath);
    expect(args).toEqual(["--yes", "skills", "add", args[3]!, "-y"]);
    expect(existsSync(join(args[3]!, "SKILL.md"))).toBe(true);
    expect(readFileSync(stub.cwdPath, "utf8").trimEnd()).toBe(realpathSync(dir));
  });
});

test("skill install --project --json reports the same result as the global install", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const stub = stubNpx(dir);
    const result = await runZinn(["skill", "install", "--project", "--json"], dir, stub.env);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ source: npxArgs(stub.argsPath)[3] });
    expect(result.stderr).toContain("stub npx ran");
  });
});

test("skill install --json keeps stdout for the result and reports the skills CLI output as notices", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const stub = stubNpx(dir);
    const result = await runZinn(["skill", "install", "--json"], dir, stub.env);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ source: npxArgs(stub.argsPath)[3] });
    expect(result.stderr).toContain("stub npx ran");
  });
});

test("skill install exits with the skills CLI's exit code when it fails", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const stub = stubNpx(dir);
    const failingExitCode = "3";
    const env = { ...stub.env, STUB_NPX_EXIT: failingExitCode };

    const text = await runZinn(["skill", "install"], dir, env);
    expect(text.code).toBe(3);
    expect(text.stdout).toContain("stub npx ran");

    const json = await runZinn(["skill", "install", "--json"], dir, env);
    expect(json.code).toBe(3);
    expect(json.stdout).toBe("");
    const { error } = errorDocumentSchema.parse(JSON.parse(json.stderr));
    expect(error.details).toMatchObject({ exitCode: 3, path: npxArgs(stub.argsPath)[3] });
    expect(error.diagnostics).toContain("stub npx ran");
  });
});
