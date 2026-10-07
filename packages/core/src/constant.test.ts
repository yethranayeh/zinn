import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ? ZINN-172: a test run that misses ZINN_DIR must fail, not fall back to the user's own board.
// ? Each child only imports constant.ts, which reads and writes no files, so a broken guard cannot reach ~/.zinn.
const constantModule = JSON.stringify(fileURLToPath(new URL("./constant.ts", import.meta.url)));
const USER_HOME = homedir();

function resolveMainDir(environment: Record<string, string | undefined>) {
  const childEnvironment: Record<string, string | undefined> = { ...process.env, ...environment };
  delete childEnvironment.ZINN_DIR;
  for (const [name, value] of Object.entries(childEnvironment)) {
    if (value === undefined) {
      delete childEnvironment[name];
    }
  }

  const result = Bun.spawnSync([process.execPath, "--eval", `
    const { MAIN_DIR } = await import(${constantModule});
    console.log(MAIN_DIR);
  `], { env: childEnvironment });

  return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
}

test("a test run without ZINN_DIR refuses the user's own default folder", () => {
  const result = resolveMainDir({ NODE_ENV: "test", HOME: USER_HOME });

  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`Refusing to use ${join(USER_HOME, ".zinn")} in a test run`);
});

test("a test run with a temporary HOME gets that HOME's default folder", () => {
  const home = mkdtempSync(join(tmpdir(), "zinn-constant-home-"));

  try {
    expect(resolveMainDir({ NODE_ENV: "test", HOME: home })).toEqual({
      code: 0,
      stdout: join(home, ".zinn"),
      stderr: "",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("outside a test run the user's own default folder is used", () => {
  expect(resolveMainDir({ NODE_ENV: undefined, HOME: USER_HOME })).toEqual({
    code: 0,
    stdout: join(USER_HOME, ".zinn"),
    stderr: "",
  });
});
