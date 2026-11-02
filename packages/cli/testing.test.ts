import { expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { withIsolatedZinnDir } from "./test-helpers";
import { runCli } from "./testing";

const LARGER_THAN_PIPE_BUFFER = 200_000;
const CHILD_EXIT_CODE = 7;
const HANDSHAKE_TIMEOUT_MS = 3_000;
const CHILD_TIMEOUT_MS = 1_000;
const LONG_CHILD_DELAY_MS = 10_000;
const node = Bun.which("node");
if (node === null) {
  throw new Error("Node is required to check the CLI test harness on both runtimes.");
}

test.each([
  { name: "Bun", runtime: process.execPath },
  { name: "Node", runtime: node },
])("$name harness captures both pipes, exit status, arguments, cwd and environment", async ({ runtime }) => {
  await withIsolatedZinnDir(async (directory) => {
    const cliPath = join(directory, "fixture.mjs");
    writeFileSync(cliPath, `
      console.log(JSON.stringify({ cwd: process.cwd(), value: process.env.ZINN_TEST_VALUE, args: process.argv.slice(2) }));
      process.stdout.write("o".repeat(${LARGER_THAN_PIPE_BUFFER}));
      process.stderr.write("e".repeat(${LARGER_THAN_PIPE_BUFFER}));
      process.exitCode = ${CHILD_EXIT_CODE};
    `);

    const result = await runCli(["first", "two words"], {
      runtime, cliPath, cwd: directory, env: { ...TEST_ENVIRONMENT, ZINN_TEST_VALUE: "selected" },
    });

    const firstLine = result.stdout.indexOf("\n");
    expect(JSON.parse(result.stdout.slice(0, firstLine))).toEqual({
      cwd: realpathSync(directory), value: "selected", args: ["first", "two words"],
    });
    expect(result.stdout.slice(firstLine + 1)).toBe("o".repeat(LARGER_THAN_PIPE_BUFFER));
    expect(result.stderr).toBe("e".repeat(LARGER_THAN_PIPE_BUFFER));
    expect(result.code).toBe(CHILD_EXIT_CODE);
  });
});

test("a CLI child can wait for the parent to release it without blocking the parent", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const cliPath = join(directory, "fixture.mjs");
    writeFileSync(cliPath, `
      import { existsSync } from "node:fs";
      const POLL_INTERVAL_MS = 10;
      while (!existsSync("release")) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    `);
    const execution = runCli([], {
      cliPath, cwd: directory, env: TEST_ENVIRONMENT, timeoutMs: HANDSHAKE_TIMEOUT_MS,
    });
    writeFileSync(join(directory, "release"), "");

    expect((await execution).code).toBe(0);
  });
});

test("the CLI process timeout terminates a child before it completes its work", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const cliPath = join(directory, "fixture.mjs");
    writeFileSync(cliPath, `
      import { writeFileSync } from "node:fs";
      console.log("started");
      await new Promise((resolve) => setTimeout(resolve, ${LONG_CHILD_DELAY_MS}));
      writeFileSync("completed", "");
    `);

    const result = await runCli([], {
      cliPath, cwd: directory, env: TEST_ENVIRONMENT, timeoutMs: CHILD_TIMEOUT_MS,
    });

    expect(result.stdout).toContain("started");
    expect(result.stderr).toBe("");
    expect(result.code).not.toBe(0);
    expect(existsSync(join(directory, "completed"))).toBe(false);
  });
});
