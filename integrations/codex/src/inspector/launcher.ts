import type { DatabaseSync } from "node:sqlite";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { backendArguments } from "../runtime";
import { loadSettings } from "../settings";
import { openReadConnection } from "../shared/read-connection";

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const SHUTDOWN_TIMEOUT_MS = 1000;
let reader: DatabaseSync | undefined;

try {
  const settings = loadSettings();

  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXECUTABLE)) {
    throw new Error(
      "The Zinn inspector requires macOS sandbox-exec for file-write and network protection.",
    );
  }

  const databasePath = join(settings.store, "data/zinn.sqlite");
  if (existsSync(databasePath)) {
    reader = openReadConnection(settings.store);
  }

  const child = spawn(
    SANDBOX_EXECUTABLE,
    backendArguments(process.execPath, fileURLToPath(new URL("./server.mjs", import.meta.url))),
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  function shutdown(signal: NodeJS.Signals = "SIGTERM") {
    if (shutdownTimer !== undefined) {
      return;
    }
    child.kill(signal);
    shutdownTimer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
    shutdownTimer.unref();
  }

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.stdin.on("error", () => shutdown());
  process.stdout.on("error", () => shutdown());
  process.stdin.on("end", () => shutdown());
  process.stdin.on("close", () => shutdown());
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  child.on("error", () => {
    process.stderr.write("Zinn inspector could not start its protected backend.\n");
    process.exitCode = 1;
  });
  child.on("close", (exitCode, signal) => {
    clearTimeout(shutdownTimer);
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    reader?.close();
    process.exitCode = signal === "SIGTERM" || signal === "SIGINT" ? 0 : (exitCode ?? 1);
  });
} catch (error) {
  reader?.close();
  process.stderr.write(`Zinn inspector setup: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
