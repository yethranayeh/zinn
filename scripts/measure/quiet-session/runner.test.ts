import { expect, test } from "bun:test";

import { createRunner, type OutputLine } from "./runner.ts";

// These tests only run ordinary shell commands. They touch no system setting.

test("the runner captures stdout, stderr and the exit code", async () => {
  const runner = createRunner();
  const result = await runner.capture([
    "sh",
    "-c",
    "printf 'hello'; printf 'bad' >&2; exit 3",
  ]);
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toBe("hello");
  expect(result.stderr).toBe("bad");
});

test("the runner streams stdout and stderr line by line", async () => {
  const runner = createRunner();
  const lines: OutputLine[] = [];
  const handle = runner.spawn([
    "sh",
    "-c",
    "printf 'first\\nsecond\\n'; printf 'warning\\n' >&2",
  ], {
    onOutput: (output) => {
      lines.push(output);
    },
  });
  const result = await handle.done;
  expect(result.exitCode).toBe(0);
  expect(lines).toContainEqual({ stream: "stdout", line: "first" });
  expect(lines).toContainEqual({ stream: "stdout", line: "second" });
  expect(lines).toContainEqual({ stream: "stderr", line: "warning" });
});

test("stopping a process-group job ends the job", async () => {
  const runner = createRunner();
  const handle = runner.spawn(["sh", "-c", "sleep 30"], { processGroup: true });
  await handle.stop();
  const result = await handle.done;
  expect(result.exitCode).not.toBe(0);
});

test("a process-group job leads its own group in the wrapper's session", async () => {
  const runner = createRunner();
  const lines: OutputLine[] = [];
  const handle = runner.spawn(["sh", "-c", "ps -o pid=,pgid=,sess= -p $$"], {
    processGroup: true,
    onOutput: (output) => {
      lines.push(output);
    },
  });
  const result = await handle.done;
  expect(result.exitCode).toBe(0);
  const [pid, pgid, session] = lines[0]!.line.trim().split(/\s+/).map(Number);
  const ownSession = Bun.spawnSync({
    cmd: ["ps", "-o", "sess=", "-p", String(process.pid)],
    stdout: "pipe",
  });
  expect(pid).toBe(handle.pid);
  expect(pgid).toBe(pid);
  expect(session).toBe(Number(ownSession.stdout.toString().trim()));
});

test("the runner pipes lines to a process and closes its stdin", async () => {
  const runner = createRunner();
  const child = runner.pipe([
    "sh",
    "-c",
    "while IFS= read -r line; do printf 'reply %s\\n' \"$line\"; done",
  ]);
  await child.write("one");
  expect(await child.readLine()).toBe("reply one");
  await child.write("two");
  expect(await child.readLine()).toBe("reply two");
  const result = await child.close();
  expect(result.exitCode).toBe(0);
});

test("capture accepts a fixed environment and can discard stdout", async () => {
  const runner = createRunner();
  const result = await runner.capture(
    ["/bin/sh", "-c", "printf '%s' \"$MARK\"; printf 'bad' >&2; exit 4"],
    {
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp", MARK: "value" },
      discardStdout: true,
    },
  );
  expect(result.exitCode).toBe(4);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("bad");
});
