import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rexDirectory = join(import.meta.dir, "..");
const stub = join(import.meta.dir, "rex-stub.lua");
// Rex runs Lua 5.1. LuaJIT runs the same code.
const interpreters = ["lua5.1", "luajit"];
const interpreter = interpreters.map((name) => Bun.which(name)).find((path) => path !== null);
// The PATH a desktop app gives the Rex server on macOS
const serverPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const shell = "/bin/bash";

type Fixture = { bin: string; home: string };

function createFixture({ shellAddsZinn }: { shellAddsZinn: boolean }): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "zinn-rex-cli-"));
  const bin = join(directory, "bin");
  const home = join(directory, "home");
  mkdirSync(bin);
  mkdirSync(home);

  const zinn = join(bin, "zinn");
  writeFileSync(zinn, '#!/bin/sh\necho "zinn $* client=$ZINN_CLIENT"\n');
  chmodSync(zinn, 0o755);

  // Startup output, including a PATH-like line, must not be read as the shell's PATH
  const profile = ['echo "Welcome"', "echo PATH=/nowhere"];
  if (shellAddsZinn) {
    profile.push(`export PATH="${bin}:$PATH"`);
  }
  writeFileSync(join(home, ".bash_profile"), `${profile.join("\n")}\n`);

  return { bin, home };
}

function runCli(fixture: Fixture, path: string, runs: number) {
  if (interpreter === undefined) {
    throw new Error(`The Rex action tests need a Lua 5.1 interpreter: install one of ${interpreters.join(", ")}.`);
  }

  const child = Bun.spawnSync([interpreter, stub, rexDirectory], {
    env: { HOME: fixture.home, SHELL: shell, PATH: path, ZINN_TEST_RUNS: String(runs) },
  });
  expect(child.exitCode).toBe(0);
  const lines = child.stdout.toString().trim().split("\n");
  const started = lines.at(-1)!.split(" ").slice(1);
  return { runs: lines.slice(0, -1), started };
}

describe("zinn lookup from the Rex server", () => {
  test("zinn on the server's PATH runs without asking the shell", () => {
    const fixture = createFixture({ shellAddsZinn: true });
    const { runs, started } = runCli(fixture, `${fixture.bin}:${serverPath}`, 2);

    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toStartWith("result zinn task list --json");
      expect(run).toContain("zinn-rex:test/");
    }
    expect(started).not.toContain(shell);
  });

  test("zinn missing from the server's PATH runs from the login shell's PATH, asked once", () => {
    const fixture = createFixture({ shellAddsZinn: true });
    const { runs, started } = runCli(fixture, serverPath, 2);

    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toStartWith("result zinn task list --json");
      expect(run).toContain("zinn-rex:test/");
    }
    expect(started.filter((program) => program === shell)).toHaveLength(1);
  });

  test("zinn on neither PATH fails each run, and the shell is still asked once", () => {
    const fixture = createFixture({ shellAddsZinn: false });
    const { runs, started } = runCli(fixture, serverPath, 2);

    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toStartWith("error ");
    }
    expect(started.filter((program) => program === shell)).toHaveLength(1);
  });
});
