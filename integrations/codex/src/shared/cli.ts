import type { Settings } from "../settings";

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

import { backendArguments } from "../runtime";
import { openReadConnection } from "./read-connection";

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
type CliResult =
  | {
      ok: true;
      value: any;
    }
  | {
      ok: false;
      error: string;
    };
const CLI_TIMEOUT_MS = 1500;
const CLI_OUTPUT_BYTES = 8 * 1024 * 1024;

export function runCli(
  settings: Pick<Settings, "store" | "cli">,
  args: Array<string>,
  alreadyProtected = false,
): CliResult {
  let reader: ReturnType<typeof openReadConnection> | undefined;
  try {
    // Refuse absent stores before the CLI can initialize a database.
    if (!statSync(join(settings.store, "data/zinn.sqlite")).isFile()) {
      return { ok: false, error: "The selected store has no readable Zinn database." };
    }

    if (!alreadyProtected) {
      reader = openReadConnection(settings.store);
    }

    const command = alreadyProtected ? settings.cli[0]! : "/usr/bin/sandbox-exec";
    const commandArgs = [...settings.cli.slice(1), ...args, "--json"];
    const invocation = alreadyProtected
      ? commandArgs
      : backendArguments(settings.cli[0]!, ...commandArgs);
    const result = spawnSync(command, invocation, {
      cwd: settings.store,
      env: { ...process.env, ZINN_DIR: settings.store, ZINN_CODEX_CONFIG: undefined },
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: CLI_OUTPUT_BYTES,
    });

    if (result.error || result.status !== 0) {
      return {
        ok: false,
        error:
          "Could not read tasks with the configured Zinn CLI. Check its executable and database compatibility.",
      };
    }

    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: "The selected store or Zinn CLI is unavailable." };
  } finally {
    reader?.close();
  }
}
export function readTaskList(settings: Pick<Settings, "store" | "cli">, alreadyProtected = false) {
  return runCli(settings, ["task", "list", "--all"], alreadyProtected);
}
