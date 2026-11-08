/** Builds the meta.json payload shared by every measurement mode. */

import type { Runner } from "../quiet-session/runner.ts";
import type { InstallInfo } from "./setup.ts";
import {
  readHyperfineVersion,
  readRepositoryState,
  readSystemInfo,
} from "./system.ts";

export type MetaOptions = {
  mode: string;
  version: string;
  arguments: readonly string[];
  runner: Runner;
  repositoryRoot: string;
  install: InstallInfo;
  nodePath: string;
  nodeVersion: string;
  loadStart: number[];
  loadEnd: number[];
  startedAt: Date;
  endedAt: Date;
  /** Mode-specific fields, added beside the common metadata. */
  extra?: Record<string, unknown>;
};

export async function buildMeta(options: MetaOptions): Promise<unknown> {
  return {
    mode: options.mode,
    version: options.version,
    arguments: options.arguments,
    repository: await readRepositoryState(options.runner, options.repositoryRoot),
    cli: options.install.cliVersion,
    core: options.install.coreVersion,
    node: {
      path: options.nodePath,
      version: options.nodeVersion,
    },
    hyperfine: await readHyperfineVersion(options.runner),
    system: await readSystemInfo(options.runner),
    loadAverages: {
      start: options.loadStart,
      end: options.loadEnd,
    },
    startedAt: options.startedAt.toISOString(),
    endedAt: options.endedAt.toISOString(),
    ...options.extra,
  };
}
