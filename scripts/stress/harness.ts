/**
 * Shared plumbing for the stress scenarios: options, temporary directories and their safety checks,
 *  child processes with watchdogs, and failure records.
 */
import type { Subprocess } from "bun";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "index.ts");
export const CORE_WORKER = join(import.meta.dir, "core-worker.ts");
export const WRAPPER_WORKER = join(import.meta.dir, "wrapper-worker.ts");

// Node prints an ExperimentalWarning for node:sqlite on every start; it is noise in collected stderr.
export const NODE_COMMAND = ["node", "--disable-warning=ExperimentalWarning"];

// The user's live board and its retained backups. The harness refuses to touch either.
const LIVE_ZINN_DIR = join(homedir(), ".zinn");
const LIVE_BACKUP_DIR = join(homedir(), ".zinn-backups");

// Disk guards: stop before the run could crowd the disk, and stop if one run grows unexpectedly.
const MIN_FREE_BYTES = 1024 ** 3;
const MAX_RUN_BYTES = 768 * 1024 ** 2;

// Collected child stderr is for error messages, not logs; cap it so a chatty child cannot fill memory.
const MAX_CAPTURED_STDERR_CHARACTERS = 64 * 1024;

export type Options = {
  scenarios: Array<string>;
  seed: number;
  /** SIGKILLs per crash scenario (per runtime for the wrapper scenario). */
  kills: number;
  /** Concurrent processes in the concurrency scenarios. */
  processes: number;
  /** CLI commands each concurrent CLI process runs. */
  commands: number;
  /** Transactions each wrapper-level writer commits in the mixed-runtime scenario. */
  transactions: number;
  /** Tasks seeded before the backup crash scenario, so VACUUM INTO takes long enough to interrupt. */
  seedTasks: number;
  keep: boolean;
  baseDirectory: string;
};

export const DEFAULT_OPTIONS: Omit<Options, "scenarios" | "seed"> = {
  kills: 30,
  processes: 6,
  commands: 20,
  transactions: 300,
  seedTasks: 3000,
  keep: false,
  baseDirectory: tmpdir(),
};

export type Failure = {
  scenario: string;
  kind: string;
  detail: string;
  keptDirectory: string | null;
};

export type ScenarioResult = {
  name: string;
  iterations: number;
  failures: Array<Failure>;
  /** Observations that are not failures, such as errors a user would see or timing. */
  notes: Array<string>;
};

export function createResult(name: string): ScenarioResult {
  return { name, iterations: 0, failures: [], notes: [] };
}

/** The command that reruns one scenario with the same seed and sizes. */
export function reproduceCommand(options: Options, scenario: string) {
  const parts = ["bun run test:stress", `--scenario ${scenario}`, `--seed ${options.seed}`];

  for (const key of ["kills", "processes", "commands", "transactions", "seedTasks"] as const) {
    if (options[key] !== DEFAULT_OPTIONS[key]) {
      parts.push(`--${toFlag(key)} ${options[key]}`);
    }
  }

  return parts.join(" ");
}

function toFlag(key: string) {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function resolveExisting(path: string) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isInside(path: string, directory: string) {
  return path === directory || path.startsWith(directory + sep);
}

function assertNotLive(path: string) {
  const resolved = resolveExisting(path);

  for (const live of [LIVE_ZINN_DIR, LIVE_BACKUP_DIR]) {
    const liveResolved = resolveExisting(live);
    if (isInside(resolved, liveResolved) || isInside(liveResolved, resolved)) {
      throw new Error(
        `Refusing to use ${resolved}: it overlaps the live Zinn data at ${liveResolved}`,
      );
    }
  }
}

/** One directory per harness run. Every child's ZINN_DIR must be inside it. */
export class RunDirectory {
  readonly root: string;
  private counter = 0;

  constructor(baseDirectory: string, seed: number) {
    assertNotLive(baseDirectory);
    mkdirSync(baseDirectory, { recursive: true });
    this.root = realpathSync(mkdtempSync(join(baseDirectory, `zinn-stress-${seed}-`)));
    assertNotLive(this.root);
  }

  /** A new, empty, isolated directory, e.g. for one ZINN_DIR. */
  create(label: string) {
    this.counter++;
    const directory = join(this.root, `${label}-${this.counter}`);
    mkdirSync(directory);
    this.assertIsolated(directory);
    return directory;
  }

  /** Throws unless the directory is inside this run's root and away from the live data. */
  assertIsolated(directory: string) {
    const resolved = resolveExisting(directory);
    assertNotLive(resolved);

    if (!isInside(resolved, this.root) || resolved === this.root) {
      throw new Error(
        `Refusing to use ${resolved}: it is outside the harness directory ${this.root}`,
      );
    }
  }

  /** Throws when free space is low or this run has grown past its budget. */
  checkDisk() {
    const filesystem = statfsSync(this.root);
    const freeBytes = filesystem.bavail * filesystem.bsize;

    if (freeBytes < MIN_FREE_BYTES) {
      throw new Error(`Stopping: only ${formatBytes(freeBytes)} free on the harness filesystem`);
    }

    const usedBytes = directorySize(this.root);
    if (usedBytes > MAX_RUN_BYTES) {
      throw new Error(`Stopping: the harness directory grew to ${formatBytes(usedBytes)}`);
    }
  }

  remove(directory: string) {
    this.assertIsolated(directory);
    rmSync(directory, { recursive: true, force: true });
  }

  removeRoot() {
    assertNotLive(this.root);
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function directorySize(directory: string): number {
  let total = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(path);
    } else if (entry.isFile()) {
      total += statSync(path).size;
    }
  }

  return total;
}

export function formatBytes(bytes: number) {
  return bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
}

export function sleep(milliseconds: number) {
  return new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

type LineListener = (line: string, receivedAt: number) => void;

/** A child process with a watchdog, line-by-line stdout and capped stderr. */
export class Child {
  readonly process: Subprocess<"ignore", "pipe", "pipe">;
  readonly startedAt = performance.now();
  readonly lines: Array<string> = [];
  stderr = "";
  wasKilled = false;
  timedOut = false;
  readonly exited: Promise<number | null>;
  private readonly listeners = new Set<LineListener>();

  constructor(
    command: Array<string>,
    zinnDirectory: string,
    timeoutMs: number,
    extraEnvironment: Record<string, string> = {},
  ) {
    this.process = Bun.spawn(command, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnvironment, ZINN_DIR: zinnDirectory },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const watchdog = setTimeout(() => {
      this.timedOut = true;
      this.kill();
    }, timeoutMs);

    const stdoutDone = this.readLines();
    const stderrDone = this.readStderr();
    this.exited = Promise.all([this.process.exited, stdoutDone, stderrDone]).then(() => {
      clearTimeout(watchdog);
      return this.process.exitCode;
    });
  }

  get pid() {
    return this.process.pid;
  }

  kill() {
    if (this.process.exitCode == null && this.process.signalCode == null) {
      this.wasKilled = true;
      this.process.kill("SIGKILL");
    }
  }

  onLine(listener: LineListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the first matching line, or null when the child exits or the wait times out. */
  waitForLine(matches: (line: string) => boolean, timeoutMs: number) {
    return new Promise<string | null>((resolveLine) => {
      const existing = this.lines.find(matches);
      if (existing != null) {
        resolveLine(existing);
        return;
      }

      const timer = setTimeout(() => finish(null), timeoutMs);
      const stopListening = this.onLine((line) => {
        if (matches(line)) {
          finish(line);
        }
      });
      this.exited.then(() => finish(null));

      function finish(line: string | null) {
        clearTimeout(timer);
        stopListening();
        resolveLine(line);
      }
    });
  }

  private async readLines() {
    const decoder = new TextDecoder();
    let pending = "";

    for await (const chunk of this.process.stdout) {
      const receivedAt = performance.now();
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");

      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        this.lines.push(line);
        for (const listener of this.listeners) {
          listener(line, receivedAt);
        }
        newline = pending.indexOf("\n");
      }
    }

    if (pending.length > 0) {
      this.lines.push(pending);
    }
  }

  private async readStderr() {
    const decoder = new TextDecoder();

    for await (const chunk of this.process.stderr) {
      if (this.stderr.length < MAX_CAPTURED_STDERR_CHARACTERS) {
        this.stderr += decoder.decode(chunk, { stream: true });
      }
    }
  }
}

/** Runs a command to completion and returns its exit code, stdout, stderr and duration. */
export async function runToCompletion(
  command: Array<string>,
  zinnDirectory: string,
  timeoutMs: number,
  extraEnvironment: Record<string, string> = {},
) {
  const child = new Child(command, zinnDirectory, timeoutMs, extraEnvironment);
  const exitCode = await child.exited;

  return {
    exitCode,
    stdout: child.lines.join("\n"),
    stderr: child.stderr,
    durationMs: performance.now() - child.startedAt,
    timedOut: child.timedOut,
  };
}

/** The real user path: this repository's CLI, run by Bun. */
export function cliCommand(args: Array<string>) {
  return ["bun", CLI_ENTRY, ...args];
}

export function percentile(sortedValues: Array<number>, fraction: number) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length));
  return sortedValues[index]!;
}

export function describeLatencies(values: Array<number>) {
  const sorted = [...values].sort((a, b) => a - b);
  const format = (value: number) => `${Math.round(value)}`;

  return `n=${sorted.length} p50=${format(percentile(sorted, 0.5))}ms p90=${format(percentile(sorted, 0.9))}ms p99=${format(percentile(sorted, 0.99))}ms max=${format(sorted.at(-1) ?? 0)}ms`;
}

/** Counts identical messages, so error summaries stay short. */
export function countBy(values: Array<string>) {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
