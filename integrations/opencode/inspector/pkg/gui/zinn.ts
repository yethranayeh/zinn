import type { BoardSummary } from "./ipc.ts";

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type ZinnCli = {
  file: string;
  prefix: Array<string>;
};

/** The first existing file named by `names`, searched along PATH. */
const onPath = (names: readonly string[]): string => {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return "";
};

/**
 * Where the CLI's entry file can be for a desktop app whose PATH lacks the shell context
 */
const cliRoots = (): Array<string> =>
  [
    join(homedir(), ".bun", "install", "global", "node_modules", "@zinn-dev", "cli", "index.js"),
    process.env.APPDATA
      ? join(process.env.APPDATA, "npm", "node_modules", "@zinn-dev", "cli", "index.js")
      : "",
    join(homedir(), ".npm-global", "lib", "node_modules", "@zinn-dev", "cli", "index.js"),
    "/usr/local/lib/node_modules/@zinn-dev/cli/index.js",
    "/usr/lib/node_modules/@zinn-dev/cli/index.js",
  ].filter(Boolean);

/**
 * A `zinn` executable wins because it needs no node.
 * Then node plus the CLI's entry file.
 * A `.cmd`/`.bat` cannot be started by `execFile` without a shell,
 *  so Windows accepts only `zinn.exe`
 */
export const resolveZinn = (): ZinnCli => {
  if (process.env.ZINN_BIN) {
    return { file: process.env.ZINN_BIN, prefix: [] };
  }

  const bin = onPath(process.platform === "win32" ? ["zinn.exe"] : ["zinn"]);
  if (bin) {
    return { file: bin, prefix: [] };
  }

  const node =
    process.env.ZINN_NODE ?? onPath(process.platform === "win32" ? ["node.exe"] : ["node"]);
  const cli = process.env.ZINN_CLI ?? cliRoots().find((candidate) => existsSync(candidate)) ?? "";
  if (!node || !cli) {
    return { file: "", prefix: [] };
  }

  return { file: node, prefix: [cli] };
};

export const runZinn = (zinn: ZinnCli, argv: Array<string>, cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!zinn.file) {
      reject(
        new Error(
          "Zinn CLI not found. Set ZINN_BIN to the zinn executable, or ZINN_NODE and ZINN_CLI to the CLI's index.js.",
        ),
      );
      return;
    }

    execFile(
      zinn.file,
      [...zinn.prefix, ...argv],
      {
        cwd: cwd || undefined,
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() ? `${error.message}\n${stderr.trim()}` : error.message;
          reject(new Error(detail));
          return;
        }
        resolve(stdout);
      },
    );
  });

export const parseBoard = (raw: string): Array<Record<string, unknown>> => {
  const start = raw.indexOf("[");
  if (start < 0) {
    throw new Error("zinn task list returned no JSON");
  }

  return JSON.parse(raw.slice(start)) as Array<Record<string, unknown>>;
};

export const summarize = (tasks: Array<Record<string, unknown>>, readAt: number): BoardSummary => {
  const counts = new Map<string, number>();

  for (const task of tasks) {
    const column = String(task.column ?? "");
    if (!column) {
      continue;
    }

    counts.set(column, (counts.get(column) ?? 0) + 1);
  }

  return {
    total: tasks.length,
    columns: [...counts].map(([name, count]) => ({ name, count })),
    readAt,
  };
};
