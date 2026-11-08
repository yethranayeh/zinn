/** Reads machine, repository and tool facts for one run's meta.json. */

import type { Runner } from "../quiet-session/runner.ts";

export type RepositoryState = {
  commit: string;
  dirty: boolean;
};

export type SystemInfo = {
  productVersion: string;
  buildVersion: string;
  model: string;
  cpu: string;
};

async function capture(runner: Runner, argv: readonly string[], cwd?: string): Promise<string> {
  const result = await runner.capture(argv, cwd === undefined ? undefined : { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed with exit code ${result.exitCode}:\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function readLoadAverages(runner: Runner): Promise<number[]> {
  const output = await capture(runner, ["sysctl", "-n", "vm.loadavg"]);
  const values = output.match(/[0-9]+(?:\.[0-9]+)?/g);
  if (values === null || values.length !== 3) {
    throw new Error(`Could not parse load averages from: ${output}`);
  }
  return values.map(Number);
}

export async function readRepositoryState(
  runner: Runner,
  repositoryRoot: string,
): Promise<RepositoryState> {
  return {
    commit: await capture(runner, ["git", "rev-parse", "HEAD"], repositoryRoot),
    dirty: (await capture(runner, ["git", "status", "--porcelain"], repositoryRoot)).length > 0,
  };
}

export async function readNodeVersion(runner: Runner, nodePath: string): Promise<string> {
  return capture(runner, [nodePath, "--version"]);
}

export async function readHyperfineVersion(runner: Runner): Promise<string> {
  return capture(runner, ["hyperfine", "--version"]);
}

export async function readSystemInfo(runner: Runner): Promise<SystemInfo> {
  return {
    productVersion: await capture(runner, ["sw_vers", "-productVersion"]),
    buildVersion: await capture(runner, ["sw_vers", "-buildVersion"]),
    model: await capture(runner, ["sysctl", "-n", "hw.model"]),
    cpu: await capture(runner, ["sysctl", "-n", "machdep.cpu.brand_string"]),
  };
}
