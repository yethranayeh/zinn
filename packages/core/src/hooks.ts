import type { Activity } from "./types.js";
import type { HookSettings } from "./schemas/settings.js";
import type { SpawnSyncOptions } from "node:child_process";

import { spawnSync } from "node:child_process";

import { errorMessage } from "./errors.js";
import { getProcessSettings } from "./storage.js";

/** One line of a hook's stdin: the activity record as `zinn activity list --json` prints it, plus the task key. */
export type HookRecord = Activity & { task_key: string | null };

/** `ZINN_HOOKS=0` saves changes without running hooks. The runner sets it for every hook, so a hook's own writes run none. */
const HOOKS_SWITCH_VARIABLE = "ZINN_HOOKS";
const HOOKS_OFF = "0";
const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
const MILLISECONDS_PER_SECOND = 1000;
/** The longest timer Node and Bun accept */
const LONGEST_TIMEOUT_MS = 2_147_483_647;
const STDERR_FD = 2;
/** On Windows, `detached` opens a console window instead of starting a process group */
const RUNS_IN_OWN_GROUP = process.platform !== "win32";

/** Ends every process, like programs its shell started, which are left in the timed-out hook's group */
function killGroup(pid: number | undefined) {
  if (!RUNS_IN_OWN_GROUP || pid === undefined) {
    return;
  }

  try {
    // A negative pid signals the whole process group
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: every process in the group has already exited
  }
}

/** Records of the change being written, or null when no hook will run. */
let pendingRecords: Array<HookRecord> | null = null;

function activeHooks(): Array<[string, HookSettings]> {
  if (process.env[HOOKS_SWITCH_VARIABLE] === HOOKS_OFF) {
    return [];
  }

  return Object.entries(getProcessSettings().global?.settings.hooks ?? {});
}

/** Whether the change being written collects records for hooks. */
export function isRecordingChange() {
  return pendingRecords !== null;
}

export function recordChange(record: HookRecord) {
  pendingRecords?.push(record);
}

/** Runs `commit`, then each configured hook once with the records it wrote. A change that wrote no records runs none. */
export function withChangeHooks<T>(commit: () => T): T {
  const hooks = activeHooks();
  if (hooks.length === 0) {
    return commit();
  }

  pendingRecords = [];
  let result: T;
  let records: Array<HookRecord>;
  try {
    result = commit();
  } finally {
    records = pendingRecords;
    pendingRecords = null;
  }

  if (records.length > 0) {
    runHooks(hooks, records);
  }

  return result;
}

function warn(name: string, problem: string) {
  process.stderr.write(`Warning: hook "${name}" ${problem}. The change was saved.\n`);
}

/** Runs each hook in order. A failing hook only warns: the change is already committed. */
function runHooks(hooks: Array<[string, HookSettings]>, records: Array<HookRecord>) {
  const input = records.map((record) => `${JSON.stringify(record)}\n`).join("");

  for (const [name, hook] of hooks) {
    try {
      const timeoutSeconds = hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS;
      // Output goes straight to stderr with no pipe held, so zinn waits for the hook to exit
      const options: SpawnSyncOptions & { detached: boolean } = {
        shell: true,
        input,
        stdio: ["pipe", STDERR_FD, STDERR_FD],
        env: { ...process.env, [HOOKS_SWITCH_VARIABLE]: HOOKS_OFF },
        // The hook's own process group lets a timeout end the programs it started, as coreutils timeout does.
        // Node and Bun honour `detached` in spawnSync, though @types/node only declares it for spawn.
        detached: RUNS_IN_OWN_GROUP,
        // spawnSync accepts only whole milliseconds
        timeout: Math.min(Math.ceil(timeoutSeconds * MILLISECONDS_PER_SECOND), LONGEST_TIMEOUT_MS),
        // SIGTERM could be ignored, and spawnSync would then wait for the hook without limit
        killSignal: "SIGKILL",
      };
      const result = spawnSync(hook.command, options);
      const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;

      if (errorCode === "ETIMEDOUT") {
        killGroup(result.pid);
        warn(name, `did not finish within ${timeoutSeconds} seconds and was stopped`);
      } else if (result.error != null && errorCode !== "EPIPE") {
        // EPIPE: the hook exited without reading all of its stdin, which git also allows.
        warn(name, `could not run (${errorMessage(result.error)})`);
      } else if (result.signal != null) {
        warn(name, `was ended by ${result.signal}`);
      } else if (result.status !== 0) {
        warn(name, `exited with status ${result.status}`);
      }
    } catch (error) {
      warn(name, `could not run (${errorMessage(error)})`);
    }
  }
}
