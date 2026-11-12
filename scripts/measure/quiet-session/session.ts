/** Prepares the Mac, runs the jobs and restores every changed setting on the way out. */

import type { CommandResult, PipeProcess, ProcessHandle, Runner } from "./runner.ts";
import type { JobSpec } from "./jobs.ts";
import type { RestoreResult } from "./restore.ts";
import type { PlannedChange, SettingFlags } from "./settings.ts";
import type { RestoreEntry, RestoreState } from "./state.ts";

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatEstimate,
  formatSessionId,
} from "./format.ts";
import { restoreEntries } from "./restore.ts";
import {
  DEFAULT_SAMPLE_SECONDS,
  SAMPLES_FILE_NAME,
  SESSION_SAMPLES_ENV,
  type Sampler,
  startSampler,
} from "./sampler.ts";
import { planSettingChanges } from "./settings.ts";
import { removeRestoreState, writeRestoreState } from "./state.ts";

export const RESTORE_COMMAND = "bun run measure:quiet restore";

const DEFAULT_SUDO_REFRESH_MS = 60_000;
const GUARD_SCRIPT = resolve(import.meta.dir, "guard.sh");
const GUARD_LOG_NAME = "guard.log";
const GUARD_READY_LINE = "ready";
const SIGNAL_EXIT_CODES: Record<SessionSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export type SessionSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export type SignalSource = {
  on: (handler: (signal: SessionSignal) => void) => () => void;
};

export type SessionOptions = {
  runner: Runner;
  settings: SettingFlags;
  jobs: readonly JobSpec[];
  stopOnFailure: boolean;
  dryRun: boolean;
  outDir: string;
  cwd: string;
  statePath: string;
  sessionId: string;
  startedAt: Date;
  signalSource: SignalSource;
  write?: (text: string) => void;
  now?: () => Date;
  sudoRefreshIntervalMs?: number;
  /** Seconds between load and process samples. */
  sampleSeconds?: number;
  notify?: boolean;
};

export type JobResult = {
  job: JobSpec;
  exitCode: number;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
};

export type SessionOutcome = {
  exitCode: number;
  sessionDir: string;
  logPath: string;
  statusPath: string;
  jobs: Array<JobResult>;
  restores: Array<RestoreResult>;
  restoredAll: boolean;
  sessionError?: string;
};

type Step = { kind: "change"; change: PlannedChange } | { kind: "job"; job: JobSpec };

type ChangeResult = { change: PlannedChange; exitCode: number; stderr: string };

export async function runSession(options: SessionOptions): Promise<SessionOutcome> {
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const sessionDir = join(options.outDir, "sessions", options.sessionId);
  const logPath = join(sessionDir, "session.log");
  const guardLogPath = join(sessionDir, GUARD_LOG_NAME);
  const statusPath = join(sessionDir, "status.txt");
  const outStatusPath = join(options.outDir, "status.txt");
  const samplesPath = join(sessionDir, SAMPLES_FILE_NAME);
  const sampleSeconds = options.sampleSeconds ?? DEFAULT_SAMPLE_SECONDS;
  const jobResults: Array<JobResult> = [];
  const changeResults: Array<ChangeResult> = [];
  let restoreResults: Array<RestoreResult> = [];

  if (existsSync(options.statePath)) {
    write("A previous session did not restore its changes.\n");
    write(`Run: ${RESTORE_COMMAND}\n`);
    write(`State file: ${options.statePath}\n`);
    return {
      exitCode: 1,
      sessionDir,
      logPath,
      statusPath,
      jobs: jobResults,
      restores: restoreResults,
      restoredAll: false,
      sessionError: "restore state already exists",
    };
  }

  if (!options.dryRun) {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(logPath, "");
  }
  const log = new SessionLog(write, options.dryRun ? undefined : logPath, now);

  let interrupted: SessionSignal | undefined;
  let currentJob: ProcessHandle | undefined;
  let restoreStarted = false;
  let stateWritten = false;
  let stateRemovalFailed = false;
  let sessionError: string | undefined;
  let changeFailureCount = 0;
  let caffeinate: ProcessHandle | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let sampler: Sampler | undefined;
  let status: StatusWriter | undefined;
  let guard: PipeProcess | undefined;
  let guardUsable = false;
  let plannedChanges: Array<PlannedChange> = [];
  let steps: Array<Step> = [];
  let expectedEnd: Date | undefined;
  let restoredAll = true;
  let exitCode = 0;

  const unregister = options.signalSource.on((signal) => {
    if (interrupted !== undefined || restoreStarted) {
      return;
    }
    interrupted = signal;
    log.line(`Received ${signal}, stopping the current job`);
    if (currentJob !== undefined) {
      void currentJob.stop();
    }
  });

  const requestGuard = async (request: string): Promise<CommandResult> => {
    if (guard === undefined) {
      throw new Error("the restore guard is not running");
    }
    await guard.write(request);
    const line = await guard.readLine();
    return parseGuardReply(line);
  };

  const startGuard = async (): Promise<PipeProcess> => {
    writeFileSync(guardLogPath, "");
    const child = options.runner.pipe(
      [
        "sudo",
        "-n",
        "/bin/sh",
        GUARD_SCRIPT,
        guardLogPath,
        options.statePath,
        statusPath,
        outStatusPath,
      ],
      { cwd: options.cwd },
    );
    let firstLine: string;
    try {
      firstLine = await child.readLine();
    } catch (error) {
      let detail = "";
      try {
        const closed = await child.close();
        detail = ` (exit ${closed.exitCode})${stderrDetail(closed.stderr)}`;
      } catch {
        // The first failure is the one to report.
      }
      throw new Error(`the restore guard did not start: ${errorMessage(error)}${detail}`);
    }
    if (firstLine !== GUARD_READY_LINE) {
      try {
        await child.close();
      } catch {
        // The unexpected line is the failure to report.
      }
      throw new Error(
        `the restore guard did not start: unexpected first line ${JSON.stringify(firstLine)}`,
      );
    }
    return child;
  };

  const applyChange = async (change: PlannedChange): Promise<CommandResult> => {
    if (guard !== undefined && guardUsable) {
      try {
        return await requestGuard(`apply ${change.guard}`);
      } catch (error) {
        guardUsable = false;
        log.line(
          `The restore guard stopped (${errorMessage(error)}), changing settings directly with sudo`,
        );
      }
    }
    return options.runner.capture(change.apply);
  };

  const undoChange = async (entry: PlannedChange): Promise<CommandResult> => {
    if (guard !== undefined && guardUsable) {
      try {
        return await requestGuard(`undo ${entry.guard}`);
      } catch (error) {
        guardUsable = false;
        log.line(`The restore guard stopped (${errorMessage(error)}), undoing directly with sudo`);
      }
    }
    return options.runner.capture(entry.undo);
  };

  const closeGuard = async (): Promise<void> => {
    if (guard === undefined) {
      return;
    }
    const child = guard;
    guard = undefined;
    let sentEnd = false;
    if (guardUsable) {
      try {
        await child.write("END");
        sentEnd = true;
      } catch (error) {
        log.line(`Could not send END to the restore guard: ${errorMessage(error)}`);
      }
    }
    try {
      const closed = await child.close();
      if (closed.exitCode !== 0) {
        log.line(`Restore guard exited ${closed.exitCode}${stderrDetail(closed.stderr)}`);
      } else if (sentEnd) {
        log.line("Restore guard exited after END");
      } else {
        log.line("Restore guard exited");
      }
    } catch (error) {
      log.line(`Could not close the restore guard: ${errorMessage(error)}`);
    }
  };

  try {
    log.line(`Session ${options.sessionId} started ${formatDateTime(options.startedAt)}`);
    log.line(`Working directory: ${options.cwd}`);

    if (!options.dryRun) {
      log.line("Asking for your password once with sudo -v");
      const sudoResult = await options.runner.interactive(["sudo", "-v"], { cwd: options.cwd });
      if (sudoResult.exitCode !== 0) {
        throw new Error(`sudo was not granted (exit ${sudoResult.exitCode})`);
      }
      const ownPid = String(process.pid);
      caffeinate = options.runner.spawn(["caffeinate", "-dimsu", "-w", ownPid], {
        cwd: options.cwd,
      });
      log.line(`Keeping the Mac awake with caffeinate -dimsu -w ${ownPid}`);
      const refreshInterval = options.sudoRefreshIntervalMs ?? DEFAULT_SUDO_REFRESH_MS;
      refreshTimer = setInterval(() => {
        void options.runner.capture(["sudo", "-n", "-v"]).then(
          (result) => {
            if (result.exitCode !== 0) {
              log.line(`sudo refresh failed (exit ${result.exitCode})`);
            }
          },
          (error: unknown) => {
            log.line(`sudo refresh failed: ${errorMessage(error)}`);
          },
        );
      }, refreshInterval);
      refreshTimer.unref?.();
      sampler = startSampler({
        runner: options.runner,
        path: samplesPath,
        intervalMs: sampleSeconds * 1000,
        now,
        onFirstFailure: (message) => {
          log.line(`A load sample failed (${message}), sampling continues`);
        },
      });
      log.line(`Sampling load and the busiest processes every ${sampleSeconds} s`);
    }

    const plan = await planSettingChanges(options.runner, options.settings, {
      allowSudoReads: !options.dryRun,
    });
    plannedChanges = plan.changes;
    steps = [
      ...plannedChanges.map((change): Step => ({ kind: "change", change })),
      ...options.jobs.map((job): Step => ({ kind: "job", job })),
    ];
    const estimates = estimateJobs(options.jobs);
    expectedEnd = estimates.allEstimated
      ? new Date(options.startedAt.getTime() + estimates.totalMinutes * 60_000)
      : undefined;

    printPlan({
      log,
      sessionId: options.sessionId,
      steps,
      changes: plannedChanges,
      jobs: options.jobs,
      notes: plan.notes,
      reads: plan.reads,
      expectedEnd,
      totalMinutes: estimates.totalMinutes,
      allEstimated: estimates.allEstimated,
      logPath,
      statusPath,
      guardPath: GUARD_SCRIPT,
      guardLogPath,
      samplesPath,
      sampleSeconds,
      dryRun: options.dryRun,
    });

    if (options.dryRun) {
      log.line("Dry run complete. Nothing was changed and no password was requested.");
    } else if (interrupted !== undefined) {
      log.line(`Interrupted by ${interrupted} before any change was made`);
    } else {
      status = new StatusWriter(options.sessionId, statusPath, outStatusPath, now);
      status.setPlan(steps.length, expectedEnd);
      const firstLabel = steps[0] === undefined ? "Finish" : stepLabel(steps[0]);
      status.beginStep(0, steps.length, "Starting", firstLabel);

      if (plannedChanges.length > 0) {
        guard = await startGuard();
        guardUsable = true;
        log.line(`Started the restore guard, log: ${guardLogPath}`);
        writeRestoreState(options.statePath, buildState(options, plannedChanges));
        stateWritten = true;
        log.line(`Wrote restore state to ${options.statePath}`);
      }

      for (let index = 0; index < steps.length; index++) {
        if (interrupted !== undefined) {
          break;
        }
        const step = steps[index]!;
        const stepNumber = index + 1;
        const nextStep = steps[index + 1];
        const nextLabel = nextStep === undefined ? "Restore system settings" : stepLabel(nextStep);
        if (step.kind === "change") {
          const result = await runChangeStep({
            options,
            changes: plannedChanges,
            change: step.change,
            stepNumber,
            stepTotal: steps.length,
            nextLabel,
            log,
            status,
            apply: applyChange,
          });
          changeResults.push(result);
          if (result.exitCode !== 0) {
            changeFailureCount++;
          }
        } else {
          const result = await runJobStep({
            options,
            job: step.job,
            stepNumber,
            stepTotal: steps.length,
            nextLabel,
            log,
            status,
            now,
            extraEnv:
              sampler === undefined ? undefined : { [SESSION_SAMPLES_ENV]: samplesPath },
            onProcess: (handle) => {
              currentJob = handle;
            },
          });
          jobResults.push(result);
          currentJob = undefined;
          if (result.exitCode !== 0 && options.stopOnFailure) {
            log.line("Stopping after the failed job because --stop-on-failure was given");
            break;
          }
        }
      }
    }
  } catch (error) {
    sessionError = errorMessage(error);
    exitCode = 1;
    log.line(`Session error: ${sessionError}`);
  } finally {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
    }
    if (sampler !== undefined) {
      await sampler.stop();
    }

    if (!options.dryRun) {
      restoreStarted = true;
      if (stateWritten) {
        log.line(`Restoring ${plannedChanges.length} changed system setting(s)`);
        status?.beginRestore("Restoring system settings", "Finish");
        try {
          restoreResults = await restoreEntries(
            options.runner,
            plannedChanges,
            {
              before: (entry, index, total) => {
                log.line(`[restore ${index + 1}/${total}] ${entry.label}: ${entry.undoCommand}`);
                status?.beginRestore(
                  `Restoring ${entry.label}`,
                  index + 1 < total ? "Next change" : "Finish",
                );
              },
              after: (result, index, total) => {
                const outcome = result.ok ? "exit 0" : `exit ${result.exitCode} (failed)`;
                log.line(`[restore ${index + 1}/${total}] ${outcome}`);
                const detail = result.error ?? result.stderr.trim();
                if (detail.length > 0) {
                  log.line(detail);
                }
              },
            },
            undoChange,
          );
          if (restoreResults.every((result) => result.ok)) {
            try {
              removeRestoreState(options.statePath);
              log.line(`Removed restore state ${options.statePath}`);
            } catch (error) {
              stateRemovalFailed = true;
              log.line(`Could not remove restore state: ${errorMessage(error)}`);
            }
          }
          if (restoreResults.some((result) => !result.ok) || stateRemovalFailed) {
            log.line("Not every system setting was restored");
            logManualCommands(plannedChanges, log);
            log.line(`State file kept at ${options.statePath}`);
          }
        } catch (error) {
          restoreResults = [];
          stateRemovalFailed = true;
          log.line(`Restore failed: ${errorMessage(error)}`);
          logManualCommands(plannedChanges, log);
          log.line(`State file kept at ${options.statePath}`);
        }
      } else {
        log.line("No system settings were changed, so nothing needs restoring");
      }

      await closeGuard();

      if (caffeinate !== undefined) {
        try {
          await caffeinate.stop();
        } catch (error) {
          log.line(`Could not stop caffeinate: ${errorMessage(error)}`);
        }
      }

      restoredAll = restoreResults.every((result) => result.ok) && !stateRemovalFailed;
      exitCode = sessionExitCode({
        jobResults,
        changeFailureCount,
        restoreResults,
        restoredAll,
        sessionError,
        interrupted,
      });
      logSummary({
        log,
        options,
        jobResults,
        changeResults,
        restoreResults,
        restoredAll,
        stateWritten,
        exitCode,
        logPath,
        sessionDir,
      });
      status?.finish(
        [
          exitCode === 0
            ? "Finished: all jobs succeeded, everything restored."
            : "Finished with failures, see the log.",
          `Jobs: ${summarizeJobs(jobResults)}`,
          `Restores: ${
            restoreResults.length === 0
              ? "none needed"
              : `${restoreResults.filter((result) => result.ok).length} of ${restoreResults.length} ok`
          }`,
          `Log: ${logPath}`,
          `Session: ${sessionDir}`,
        ].join("\n"),
      );
      if (options.notify !== false) {
        await sendNotification(options, {
          jobResults,
          plannedJobs: options.jobs.length,
          restoredAll,
          changeFailureCount,
          sessionError,
          interrupted,
          log,
        });
      }
    }
    unregister();
  }

  if (options.dryRun) {
    return {
      exitCode: interrupted === undefined ? exitCode : SIGNAL_EXIT_CODES[interrupted],
      sessionDir,
      logPath,
      statusPath,
      jobs: jobResults,
      restores: restoreResults,
      restoredAll: true,
    };
  }

  return {
    exitCode,
    sessionDir,
    logPath,
    statusPath,
    jobs: jobResults,
    restores: restoreResults,
    restoredAll,
    sessionError,
  };
}

/** Picks `<timestamp>` or `<timestamp>-1`, `-2` when that session folder already exists. */
export function sessionFolderId(outDir: string, startedAt: Date): string {
  const base = formatSessionId(startedAt);
  let candidate = base;
  let suffix = 1;
  while (existsSync(join(outDir, "sessions", candidate))) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  return candidate;
}

class SessionLog {
  private fileFailed = false;

  constructor(
    private readonly write: (text: string) => void,
    private readonly logPath: string | undefined,
    private readonly now: () => Date,
  ) {}

  line(text: string): void {
    for (const part of text.split(/\r?\n/)) {
      this.writeLine(part);
    }
  }

  private writeLine(text: string): void {
    const rendered = `[${formatClock(this.now())}] ${text}`;
    try {
      this.write(`${rendered}\n`);
    } catch {
      // A closed terminal must not stop the session or its restore.
    }
    if (this.logPath !== undefined && !this.fileFailed) {
      try {
        appendFileSync(this.logPath, `${rendered}\n`);
      } catch (error) {
        this.fileFailed = true;
        this.writeLine(`[log] could not write ${this.logPath}: ${errorMessage(error)}`);
      }
    }
  }
}

class StatusWriter {
  private stepNumber = 0;
  private stepTotal = 0;
  private stepLabel = "Starting";
  private nextLabel = "";
  private job:
    | { name: string; startedAt: Date; estimateMinutes?: number; lastLine?: string }
    | undefined;
  private expectedEnd: Date | undefined;
  private finished: string | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly statusPath: string,
    private readonly outStatusPath: string,
    private readonly now: () => Date,
  ) {}

  setPlan(total: number, expectedEnd: Date | undefined): void {
    this.stepTotal = total;
    this.expectedEnd = expectedEnd;
    this.write();
  }

  beginStep(number: number, total: number, label: string, nextLabel: string): void {
    this.stepNumber = number;
    this.stepTotal = total;
    this.stepLabel = label;
    this.nextLabel = nextLabel;
    this.job = undefined;
    this.write();
  }

  beginJob(number: number, total: number, job: JobSpec, nextLabel: string): void {
    this.stepNumber = number;
    this.stepTotal = total;
    this.stepLabel = `Job ${job.name}`;
    this.nextLabel = nextLabel;
    this.job = {
      name: job.name,
      startedAt: this.now(),
      estimateMinutes: job.estimateMinutes,
    };
    this.write();
  }

  jobOutput(line: string): void {
    if (this.job !== undefined) {
      this.job.lastLine = line;
    }
    this.write();
  }

  beginRestore(label: string, nextLabel: string): void {
    this.stepLabel = label;
    this.nextLabel = nextLabel;
    this.job = undefined;
    this.write();
  }

  finish(text: string): void {
    this.finished = text;
    this.write();
  }

  private write(): void {
    const content = this.render();
    try {
      writeFileSync(this.statusPath, content);
      writeFileSync(this.outStatusPath, content);
    } catch {
      // The status file is diagnostic and must not stop a restore.
    }
  }

  private render(): string {
    const lines = [`quiet-session ${this.sessionId}`];
    if (this.finished !== undefined) {
      lines.push(this.finished);
      return `${lines.join("\n")}\n`;
    }
    lines.push(`Step ${this.stepNumber}/${this.stepTotal}: ${this.stepLabel}`);
    if (this.job !== undefined) {
      const elapsed = formatDuration(this.now().getTime() - this.job.startedAt.getTime());
      const estimate =
        this.job.estimateMinutes === undefined
          ? "no estimate"
          : `estimate ${formatEstimate(this.job.estimateMinutes)}`;
      lines.push(`Current job: ${this.job.name} (elapsed ${elapsed}, ${estimate})`);
      lines.push(`Last output: ${this.job.lastLine ?? "none yet"}`);
    } else {
      lines.push("Current job: none");
      lines.push("Last output: none");
    }
    lines.push(`Next: ${this.nextLabel.length > 0 ? this.nextLabel : "nothing"}`);
    lines.push(
      `Expected end: ${this.expectedEnd === undefined ? "unknown" : formatDateTime(this.expectedEnd)}`,
    );
    return `${lines.join("\n")}\n`;
  }
}

type ChangeStepInput = {
  options: SessionOptions;
  changes: Array<PlannedChange>;
  change: PlannedChange;
  stepNumber: number;
  stepTotal: number;
  nextLabel: string;
  log: SessionLog;
  status: StatusWriter | undefined;
  apply: (change: PlannedChange) => Promise<CommandResult>;
};

async function runChangeStep(input: ChangeStepInput): Promise<ChangeResult> {
  const { options, change, stepNumber, stepTotal, nextLabel, log, status } = input;
  status?.beginStep(stepNumber, stepTotal, change.label, nextLabel);
  log.line(`[${stepNumber}/${stepTotal}] ${change.label}`);
  log.line(`  Command: ${change.applyCommand}`);
  const result = await input.apply(change);
  change.applied = true;
  change.appliedExitCode = result.exitCode;
  try {
    writeRestoreState(options.statePath, buildState(options, input.changes));
    log.line("  Updated the restore state file");
  } catch (error) {
    log.line(`  Could not update the restore state file: ${errorMessage(error)}`);
  }
  if (result.exitCode === 0) {
    log.line(`[${stepNumber}/${stepTotal}] exit 0`);
  } else {
    log.line(`[${stepNumber}/${stepTotal}] exit ${result.exitCode}`);
    const stderr = result.stderr.trim();
    if (stderr.length > 0) {
      log.line(stderr);
    }
  }
  return { change, exitCode: result.exitCode, stderr: result.stderr };
}

type JobStepInput = {
  options: SessionOptions;
  job: JobSpec;
  stepNumber: number;
  stepTotal: number;
  nextLabel: string;
  log: SessionLog;
  status: StatusWriter | undefined;
  now: () => Date;
  /** Set while the sampler runs, so a job can judge its own blocks. */
  extraEnv: Record<string, string> | undefined;
  onProcess: (handle: ProcessHandle | undefined) => void;
};

async function runJobStep(input: JobStepInput): Promise<JobResult> {
  const { options, job, stepNumber, stepTotal, nextLabel, log, status, now } = input;
  const startedAt = now();
  const estimateText =
    job.estimateMinutes === undefined
      ? "no estimate"
      : `estimate ${formatEstimate(job.estimateMinutes)}`;
  status?.beginJob(stepNumber, stepTotal, job, nextLabel);
  log.line(`[${stepNumber}/${stepTotal}] Job ${job.name}: ${job.command} (${estimateText})`);

  const argv = job.argv ?? ["sh", "-c", job.command];
  let handle: ProcessHandle;
  try {
    handle = options.runner.spawn(argv, {
      cwd: options.cwd,
      processGroup: true,
      extraEnv: input.extraEnv,
      onOutput: (output) => {
        const line = `[${job.name}] ${output.line}`;
        log.line(line);
        status?.jobOutput(line);
      },
    });
  } catch (error) {
    const endedAt = now();
    log.line(
      `[${stepNumber}/${stepTotal}] Job ${job.name} could not start: ${errorMessage(error)}`,
    );
    status?.beginStep(stepNumber, stepTotal, `Job ${job.name}`, nextLabel);
    return {
      job,
      exitCode: 1,
      startedAt,
      endedAt,
      durationMs: endedAt.getTime() - startedAt.getTime(),
    };
  }

  input.onProcess(handle);
  const result = await handle.done;
  const endedAt = now();
  const durationMs = endedAt.getTime() - startedAt.getTime();
  status?.beginStep(stepNumber, stepTotal, `Job ${job.name}`, nextLabel);
  const nextText = nextLabel === "Restore system settings" ? nextLabel : `Next: ${nextLabel}`;
  log.line(
    `[${stepNumber}/${stepTotal}] Job ${job.name} exit ${result.exitCode} after ${formatDuration(durationMs)}. ${nextText}`,
  );
  return { job, exitCode: result.exitCode, startedAt, endedAt, durationMs };
}

function buildState(options: SessionOptions, changes: readonly PlannedChange[]): RestoreState {
  return {
    version: 1,
    sessionId: options.sessionId,
    createdAt: options.startedAt.toISOString(),
    changes: changes.map(
      (change): RestoreEntry => ({
        id: change.id,
        kind: change.kind,
        label: change.label,
        priorState: change.priorState,
        undo: change.undo,
        undoCommand: change.undoCommand,
        applied: change.applied,
        appliedExitCode: change.appliedExitCode,
      }),
    ),
  };
}

function estimateJobs(jobs: readonly JobSpec[]): { totalMinutes: number; allEstimated: boolean } {
  let totalMinutes = 0;
  let allEstimated = true;
  for (const job of jobs) {
    if (job.estimateMinutes === undefined) {
      allEstimated = false;
    } else {
      totalMinutes += job.estimateMinutes;
    }
  }
  return { totalMinutes, allEstimated };
}

type PlanOutput = {
  log: SessionLog;
  sessionId: string;
  steps: Array<Step>;
  changes: Array<PlannedChange>;
  jobs: readonly JobSpec[];
  notes: Array<string>;
  reads: Array<string>;
  expectedEnd: Date | undefined;
  totalMinutes: number;
  allEstimated: boolean;
  logPath: string;
  statusPath: string;
  guardPath: string;
  guardLogPath: string;
  samplesPath: string;
  sampleSeconds: number;
  dryRun: boolean;
};

function printPlan(output: PlanOutput): void {
  const { log } = output;
  log.line(`Plan for session ${output.sessionId}`);
  log.line(`Log: ${output.logPath}`);
  log.line(`Status: ${output.statusPath}`);
  log.line(`Restore guard: /bin/sh ${output.guardPath} (starts when a system change is planned)`);
  log.line(`Guard log: ${output.guardLogPath}`);
  log.line(`Samples: ${output.samplesPath} (every ${output.sampleSeconds} s)`);
  if (output.dryRun) {
    log.line("Dry run: the plan below is not executed, no password is requested");
  }
  log.line("");
  log.line(`Plan (${output.steps.length} ${plural(output.steps.length, "step", "steps")})`);
  output.steps.forEach((step, index) => {
    const number = index + 1;
    if (step.kind === "change") {
      log.line(
        `  ${number}. ${step.change.label}. Command: ${step.change.applyCommand}. Undo: ${step.change.undoCommand}`,
      );
      return;
    }
    const estimate =
      step.job.estimateMinutes === undefined
        ? "no estimate"
        : `estimate ${formatEstimate(step.job.estimateMinutes)}`;
    log.line(`  ${number}. Job ${step.job.name}: ${step.job.command} (${estimate})`);
  });
  log.line("");
  log.line(`System changes: ${output.changes.length}`);
  log.line(`Jobs: ${output.jobs.length}, ${totalEstimateText(output)}`);
  log.line(
    `Expected end: ${
      output.expectedEnd === undefined
        ? "unknown, a job has no estimate"
        : formatDateTime(output.expectedEnd)
    }`,
  );
  for (const note of output.notes) {
    log.line(`Note: ${note}`);
  }
  if (output.reads.length > 0) {
    log.line("");
    log.line("Prior state reads (read-only):");
    for (const read of output.reads) {
      log.line(`  ${read}`);
    }
  }
  log.line("");
  log.line("Preparation commands (not settings):");
  log.line("  sudo -v");
  log.line(`  caffeinate -dimsu -w ${process.pid}`);
  log.line(`  sudo -n -v every ${Math.round(DEFAULT_SUDO_REFRESH_MS / 1_000)} seconds`);
  if (output.changes.length > 0) {
    log.line("Manual undo commands:");
    for (const change of output.changes) {
      log.line(`  ${change.undoCommand}`);
    }
  }
  log.line(`If this session dies without restoring, run: ${RESTORE_COMMAND}`);
  log.line("");
}

function totalEstimateText(output: PlanOutput): string {
  if (output.allEstimated) {
    return `total estimate ${formatEstimate(output.totalMinutes)}`;
  }
  if (output.totalMinutes > 0) {
    return `total estimate at least ${formatEstimate(output.totalMinutes)}`;
  }
  return "no job has an estimate";
}

function plural(count: number, singular: string, many: string): string {
  return count === 1 ? singular : many;
}

function logManualCommands(changes: readonly RestoreEntry[], log: SessionLog): void {
  log.line("Manual undo commands:");
  for (const change of [...changes].reverse()) {
    log.line(`  ${change.undoCommand}`);
  }
}

type ExitInput = {
  jobResults: Array<JobResult>;
  changeFailureCount: number;
  restoreResults: Array<RestoreResult>;
  restoredAll: boolean;
  sessionError: string | undefined;
  interrupted: SessionSignal | undefined;
};

function sessionExitCode(input: ExitInput): number {
  let exitCode = 0;
  if (input.sessionError !== undefined) {
    exitCode = 1;
  }
  if (input.jobResults.some((result) => result.exitCode !== 0)) {
    exitCode = 1;
  }
  if (input.changeFailureCount > 0) {
    exitCode = 1;
  }
  if (input.restoreResults.some((result) => !result.ok) || !input.restoredAll) {
    exitCode = 1;
  }
  if (input.interrupted !== undefined) {
    exitCode = SIGNAL_EXIT_CODES[input.interrupted];
  }
  return exitCode;
}

type SummaryInput = {
  log: SessionLog;
  options: SessionOptions;
  jobResults: Array<JobResult>;
  changeResults: Array<ChangeResult>;
  restoreResults: Array<RestoreResult>;
  restoredAll: boolean;
  stateWritten: boolean;
  exitCode: number;
  logPath: string;
  sessionDir: string;
};

function logSummary(input: SummaryInput): void {
  const { log } = input;
  log.line("");
  log.line("Summary");
  for (const result of input.jobResults) {
    const outcome = result.exitCode === 0 ? "ok" : `failed (exit ${result.exitCode})`;
    log.line(`  Job ${result.job.name}: ${outcome}, ${formatDuration(result.durationMs)}`);
  }
  for (const job of input.options.jobs.slice(input.jobResults.length)) {
    log.line(`  Job ${job.name}: did not run`);
  }
  log.line(`  System changes: ${input.changeResults.length} attempted`);
  if (input.restoreResults.length === 0) {
    log.line("  Restores: none needed");
  } else {
    for (const result of input.restoreResults) {
      const outcome = result.ok ? "ok" : `failed (exit ${result.exitCode})`;
      log.line(`  Restore ${result.entry.label}: ${outcome}`);
    }
  }
  let stateText = "not needed";
  if (input.stateWritten) {
    stateText = input.restoredAll ? "removed" : "kept";
  }
  log.line(`  Restore state file: ${stateText}`);
  log.line(`  Log: ${input.logPath}`);
  log.line(`  Session: ${input.sessionDir}`);
  log.line(`  Result: ${input.exitCode === 0 ? "success" : "failure"}`);
}

type NotificationInput = {
  jobResults: Array<JobResult>;
  plannedJobs: number;
  restoredAll: boolean;
  changeFailureCount: number;
  sessionError: string | undefined;
  interrupted: SessionSignal | undefined;
  log: SessionLog;
};

async function sendNotification(options: SessionOptions, input: NotificationInput): Promise<void> {
  const completed = input.jobResults.length;
  const succeeded = input.jobResults.filter((result) => result.exitCode === 0).length;
  let jobsText: string;
  if (input.plannedJobs === 0) {
    jobsText = "No jobs were planned.";
  } else if (completed === 0) {
    jobsText = `No jobs ran, ${input.plannedJobs} planned.`;
  } else if (succeeded === input.plannedJobs) {
    jobsText = `All ${input.plannedJobs} jobs succeeded.`;
  } else {
    const didNotRun = input.plannedJobs - completed;
    jobsText = `${input.plannedJobs - succeeded} of ${input.plannedJobs} jobs did not succeed`;
    jobsText += didNotRun > 0 ? `, ${didNotRun} did not run.` : ".";
  }
  const parts = [jobsText];
  if (input.interrupted !== undefined) {
    parts.push(`Interrupted by ${input.interrupted}.`);
  }
  if (input.changeFailureCount > 0) {
    const count = input.changeFailureCount;
    parts.push(`${count} setup ${plural(count, "command", "commands")} failed.`);
  }
  if (input.sessionError !== undefined) {
    parts.push("The session reported an error.");
  }
  parts.push(
    input.restoredAll ? "Everything restored." : "Restore failed, manual commands are in the log.",
  );
  const message = parts.join(" ");
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString("quiet-session")}`;
  try {
    const result = await options.runner.capture(["osascript", "-e", script]);
    if (result.exitCode !== 0) {
      input.log.line(`Notification failed (exit ${result.exitCode})`);
    }
  } catch (error) {
    input.log.line(`Notification failed: ${errorMessage(error)}`);
  }
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stepLabel(step: Step): string {
  if (step.kind === "change") {
    return step.change.label;
  }
  return `Job ${step.job.name}`;
}

function summarizeJobs(jobResults: readonly JobResult[]): string {
  if (jobResults.length === 0) {
    return "none ran";
  }
  return jobResults
    .map((result) => {
      const outcome = result.exitCode === 0 ? "ok" : `failed (exit ${result.exitCode})`;
      return `${result.job.name} ${outcome} (${formatDuration(result.durationMs)})`;
    })
    .join(", ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseGuardReply(line: string): CommandResult {
  const separator = line.indexOf(" ");
  const exitText = separator === -1 ? line : line.slice(0, separator);
  const stderr = separator === -1 ? "" : line.slice(separator + 1);
  if (!/^\d+$/.test(exitText)) {
    return { exitCode: 1, stdout: "", stderr: `unexpected guard reply: ${line}` };
  }
  return { exitCode: Number(exitText), stdout: "", stderr };
}

function stderrDetail(stderr: string): string {
  const text = stderr.trim();
  return text.length > 0 ? `: ${text}` : "";
}
