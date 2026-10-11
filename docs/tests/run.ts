import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const docsDirectory = resolve(import.meta.dir, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "zinn-site-test-"));
const emptyEnvironmentFile = join(temporaryDirectory, "empty.vars");
await Bun.write(emptyEnvironmentFile, "");
const wrangler = Bun.spawn(
  [
    process.execPath,
    "run",
    "wrangler",
    "dev",
    "--local",
    "--port",
    "0",
    "--ip",
    "127.0.0.1",
    "--show-interactive-dev-session=false",
    "--env-file",
    emptyEnvironmentFile,
  ],
  {
    cwd: docsDirectory,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: temporaryDirectory,
      WRANGLER_SEND_METRICS: "false",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
const serverErrors = new Response(wrangler.stderr).text();

let exitCode = 1;
try {
  const reader = wrangler.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let baseUrl: string | undefined;
  const startupTimeoutMs = 30_000;
  const timeout = setTimeout(() => wrangler.kill("SIGINT"), startupTimeoutMs);
  try {
    while (!baseUrl) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error(`Local Cloudflare server did not start: ${output}`);
      }
      output += decoder.decode(value, { stream: true });
      baseUrl = output.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    }
  } finally {
    clearTimeout(timeout);
  }
  // Drain request logs while the tests run.
  void (async () => {
    while (!(await reader.read()).done) {}
    reader.releaseLock();
  })();
  const tests = Bun.spawn([process.execPath, "test", "worker", "tests"], {
    cwd: docsDirectory,
    env: {
      ...process.env,
      SITE_TEST_URL: baseUrl,
      SITE_TEST_ENV: process.env.SITE_TEST_ENV ?? "production",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await tests.exited;
} finally {
  wrangler.kill("SIGINT");
  await wrangler.exited;
  const errors = await serverErrors;
  if (exitCode !== 0 && errors) {
    console.error(errors);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
process.exit(exitCode);
