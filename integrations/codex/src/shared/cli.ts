import type { SettingsOptions } from "../settings";

import { spawn } from "node:child_process";

export type Task = {
  key: string;
  title: string;
  status: string;
  column: string;
  description: string | null;
  priority: string | null;
  labels: Array<string>;
  relations?: {
    type: string;
    direction: string;
    task: Pick<Task, "key" | "title" | "column" | "status">;
  }[];
  comments?: {
    key: string;
    text: string;
  }[];
};
export type CliResult =
  | {
      ok: true;
      value: any;
    }
  | {
      ok: false;
      error: string;
      code?: string;
      entity?: string;
    };
export type CliReader = {
  run(args: Array<string>, signal?: AbortSignal): Promise<CliResult>;
  close(): Promise<void>;
};

const VERSION_TIMEOUT_MS = 1500;
const CLI_OUTPUT_BYTES = 8 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;

export const MINIMUM_CLI_VERSION = "0.43.0";
export const HOOK_VERIFICATION_BUDGET_MS = 1500;

function supportsVersion(text: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-dev)?$/.exec(text.trim());
  if (match === null) {
    return false;
  }
  const version = match.slice(1, 4).map(Number);
  const minimum = MINIMUM_CLI_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) {
      return version[index]! > minimum[index]!;
    }
  }
  return match[4] === undefined;
}

/** Owns CLI children until they exit, including cancellation and backend shutdown. */
export function createCliReader(
  settings: Pick<SettingsOptions, "store" | "cli">,
  { deadline, cwd = process.cwd() }: { deadline?: number; cwd?: string } = {},
): CliReader {
  const active = new Set<{ stop(): void; done: Promise<CliResult> }>();
  let closed = false;

  async function execute(
    args: Array<string>,
    json: boolean,
    signal?: AbortSignal,
  ): Promise<CliResult> {
    if (closed || signal?.aborted) {
      return { ok: false, error: "The Zinn read was cancelled." };
    }
    const remaining = deadline === undefined ? undefined : deadline - performance.now();
    if (remaining !== undefined && remaining <= 0) {
      return { ok: false, error: "The Zinn verification deadline was reached." };
    }
    const child = spawn(settings.cli[0]!, [...settings.cli.slice(1), ...args], {
      cwd: json ? (settings.store ?? cwd) : cwd,
      env: {
        ...process.env,
        ZINN_DIR: settings.store ?? process.env.ZINN_DIR,
        ZINN_CODEX_CONFIG: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stop = () => {
      if (killTimer !== undefined) {
        return;
      }
      failure ??= "The Zinn read was cancelled.";
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
      killTimer.unref();
    };
    const done = new Promise<CliResult>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > CLI_OUTPUT_BYTES) {
          failure = "The Zinn CLI output exceeded its limit.";
          stop();
        } else {
          stdout.push(chunk);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > CLI_OUTPUT_BYTES) {
          failure = "The Zinn CLI output exceeded its limit.";
          stop();
        } else {
          stderr.push(chunk);
        }
      });
      child.on("error", () => {
        failure = "The selected store or Zinn CLI is unavailable.";
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", stop);
        if (failure !== undefined) {
          resolve({ ok: false, error: failure });
          return;
        }
        try {
          if (status !== 0) {
            const body = JSON.parse(Buffer.concat(stderr).toString("utf8"))?.error;
            resolve({
              ok: false,
              error:
                typeof body?.message === "string"
                  ? body.message
                  : "Could not read with the configured Zinn CLI.",
              code: typeof body?.code === "string" ? body.code : undefined,
              entity: typeof body?.details?.entity === "string" ? body.details.entity : undefined,
            });
            return;
          }
          const text = Buffer.concat(stdout).toString("utf8");
          resolve({ ok: true, value: json ? JSON.parse(text) : text });
        } catch {
          resolve({ ok: false, error: "The configured Zinn CLI returned an unreadable result." });
        }
      });
    });
    const owned = { stop, done };
    active.add(owned);
    signal?.addEventListener("abort", stop, { once: true });
    const timeout = json
      ? remaining
      : Math.min(remaining ?? VERSION_TIMEOUT_MS, VERSION_TIMEOUT_MS);
    if (timeout !== undefined) {
      timer = setTimeout(() => {
        failure = "The Zinn verification deadline was reached.";
        stop();
      }, timeout);
    }
    try {
      return await done;
    } finally {
      active.delete(owned);
    }
  }

  return {
    async run(args, signal) {
      try {
        const version = await execute(["--version"], false, signal);
        if (!version.ok) {
          return version;
        }
        if (!supportsVersion(version.value)) {
          return {
            ok: false,
            error: `Use Zinn CLI ${MINIMUM_CLI_VERSION} or newer, or a -dev build after that release.`,
          };
        }
        return await execute([...args, "--json"], true, signal);
      } catch {
        return { ok: false, error: "The selected store or Zinn CLI is unavailable." };
      }
    },
    async close() {
      closed = true;
      for (const child of active) {
        child.stop();
      }
      await Promise.all([...active].map((child) => child.done));
    },
  };
}

export function readTaskList(reader: CliReader, signal?: AbortSignal) {
  return reader.run(["task", "list", "--all"], signal);
}
