import { expect, test } from "bun:test";
import { join } from "node:path";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation";
import { withIsolatedZinnDir } from "../test-helpers";

// ZINN-575
const CASE_TIMEOUT_MS = 15_000;

/** A stalled real Writable in a child process keeps stdout replacement local to the case. */
async function runFollower(body: string) {
  let result!: { code: number | null; signal: string | null; stdout: string; stderr: string };
  await withIsolatedZinnDir(async (directory) => {
    const script = `
      import assert from "node:assert/strict";
      import { Writable } from "node:stream";
      import { setTimeout as delay } from "node:timers/promises";
      import { followUntilStopped, FOLLOW_POLL_INTERVAL_MS } from ${JSON.stringify(join(import.meta.dir, "follow.ts"))};
      import { outputStream, setOutputMode } from ${JSON.stringify(join(import.meta.dir, "lib.ts"))};
      const report = process.stdout.write.bind(process.stdout);
      const firstWrite = Promise.withResolvers();
      const secondWrite = Promise.withResolvers();
      const chunks = [];
      let releaseWrite;
      let polls = 0;
      let signal;
      const output = new Writable({
        highWaterMark: 1,
        write(chunk, encoding, done) {
          chunks.push(JSON.parse(chunk.toString()));
          releaseWrite = done;
          firstWrite.resolve();
          if (chunks.length === 2) { secondWrite.resolve(); }
        },
      });
      Object.defineProperty(process, "stdout", { value: output });
      setOutputMode("json");
      const follower = followUntilStopped(async (currentSignal) => {
        signal = currentSignal;
        polls++;
        await outputStream([{ id: polls }], () => "", signal);
      });
      await firstWrite.promise;
      ${body}
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory },
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => proc.kill("SIGKILL"), CASE_TIMEOUT_MS);
    try {
      const [, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      result = { code: proc.exitCode, signal: proc.signalCode, stdout, stderr };
    } finally {
      clearTimeout(timeout);
      proc.kill("SIGKILL");
    }
  });
  return result;
}

test("a stalled output pauses polling and resumes in order after draining", async () => {
  const result = await runFollower(`
    await delay(FOLLOW_POLL_INTERVAL_MS + 100);
    assert.equal(polls, 1);
    releaseWrite();
    await secondWrite.promise;
    output.destroy(Object.assign(new Error("closed"), { code: "EPIPE" }));
    await follower;
    assert.equal(signal.aborted, true);
    assert.equal(output.listenerCount("drain"), 0);
    report(JSON.stringify({ polls, chunks }));
  `);
  expect(result.code, result.stderr).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ polls: 2, chunks: [{ id: 1 }, { id: 2 }] });
}, CASE_TIMEOUT_MS);

for (const code of ["EPIPE", "EIO"]) {
  test(`${code} ends a follower waiting for output drain`, async () => {
    const result = await runFollower(`
      const outcome = follower.then(() => ({ success: true }), (error) => ({ code: error.code }));
      output.destroy(Object.assign(new Error("output failure"), { code: ${JSON.stringify(code)} }));
      const ended = await outcome;
      assert.equal(signal.aborted, true);
      assert.equal(output.listenerCount("drain"), 0);
      report(JSON.stringify({ polls, ended }));
    `);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      polls: 1,
      ended: code === "EPIPE" ? { success: true } : { code },
    });
  }, CASE_TIMEOUT_MS);
}

test("SIGINT ends a follower while its output is stalled", async () => {
  const result = await runFollower(`
    report(JSON.stringify({ polls }));
    process.kill(process.pid, "SIGINT");
    await follower;
    throw new Error("An interrupt must end the process");
  `);
  expect(result.signal, result.stderr).toBe("SIGINT");
  expect(result.code).toBeNull();
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ polls: 1 });
}, CASE_TIMEOUT_MS);
