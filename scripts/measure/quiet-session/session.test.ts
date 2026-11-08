import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobSpec } from "./jobs.ts";
import { runRestoreCommand } from "./restore.ts";
import type {
  CommandResult,
  OutputLine,
  PipeProcess,
  ProcessHandle,
  Runner,
  SpawnOptions,
} from "./runner.ts";
import {
  runSession,
  sessionFolderId,
  type SessionOptions,
  type SessionSignal,
  type SignalSource,
} from "./session.ts";
import { writeRestoreState, type RestoreEntry } from "./state.ts";

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
const TIME_MACHINE_READ = "defaults read /Library/Preferences/com.apple.TimeMachine AutoBackup";

class FakeSignals implements SignalSource {
  private handlers: Array<(signal: SessionSignal) => void> = [];

  on(handler: (signal: SessionSignal) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((registered) => registered !== handler);
    };
  }

  emit(signal: SessionSignal): void {
    for (const handler of [...this.handlers]) {
      handler(signal);
    }
  }
}

class FakeProcess implements ProcessHandle {
  readonly pid = 4_242;
  readonly done: Promise<CommandResult>;
  stopped = false;
  private finish!: (result: CommandResult) => void;

  constructor() {
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  resolve(result: CommandResult): void {
    this.finish(result);
  }

  stop = async (): Promise<void> => {
    this.stopped = true;
    this.finish({ exitCode: 143, stdout: "", stderr: "" });
  };
}

class FakeGuard implements PipeProcess {
  readonly pid = 5_555;
  readonly requests: string[] = [];
  readonly dieOnRequests = new Set<string>();
  readonly failingRequests = new Map<string, CommandResult>();
  onRequest: ((request: string) => void) | undefined;
  private pendingReplies: string[] = ["ready"];
  private waiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private died = false;
  private startFailure: string | undefined;

  failStart(stderr: string): void {
    this.startFailure = stderr;
    this.closed = true;
  }

  async write(line: string): Promise<void> {
    if (this.closed) {
      throw new Error("fake guard is closed");
    }
    this.requests.push(line);
    this.onRequest?.(line);
    if (this.dieOnRequests.has(line)) {
      this.closed = true;
      this.died = true;
      this.rejectWaiters(new Error("fake guard died"));
      return;
    }
    const failure = this.failingRequests.get(line);
    const reply = failure === undefined ? "0 " : `${failure.exitCode} ${failure.stderr}`;
    this.pushReply(reply);
  }

  async readLine(): Promise<string> {
    if (this.startFailure !== undefined) {
      throw new Error("fake guard did not start");
    }
    const reply = this.pendingReplies.shift();
    if (reply !== undefined) {
      return reply;
    }
    if (this.closed) {
      throw new Error("fake guard is closed");
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async close(): Promise<CommandResult> {
    this.closed = true;
    this.rejectWaiters(new Error("fake guard closed"));
    const exitCode = this.startFailure !== undefined || this.died ? 1 : 0;
    return { exitCode, stdout: "", stderr: this.startFailure ?? "" };
  }

  private pushReply(reply: string): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.pendingReplies.push(reply);
      return;
    }
    waiter.resolve(reply);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      waiter.reject(error);
    }
    this.waiters = [];
  }
}

type FakeCall = { method: "capture" | "interactive" | "spawn" | "pipe"; argv: string[] };

class FakeRunner implements Runner {
  readonly calls: FakeCall[] = [];
  readonly processes: Array<{ argv: string[]; handle: FakeProcess; options?: SpawnOptions }> = [];
  readonly guards: FakeGuard[] = [];
  readonly hanging = new Map<string, FakeProcess>();
  readonly hangingCommands = new Set<string>();
  readonly failingCommands = new Set<string>();
  readonly throwingCommands = new Set<string>();
  readonly guardDieOnRequests = new Set<string>();
  readonly guardFailures = new Map<string, CommandResult>();
  readonly jobResults = new Map<string, number>();
  readonly jobOutputs = new Map<string, string[]>();
  spotlightOutput = "/:\n\tIndexing enabled. \n";
  timeMachineResult: CommandResult = { exitCode: 1, stdout: "", stderr: "not set" };
  timeMachineDestinations = true;
  wifiDevice = "en0";
  wifiPower: "On" | "Off" = "On";
  interactiveResult: CommandResult = OK;
  guardStartFailure: string | undefined;
  onCall: ((argv: readonly string[]) => void) | undefined;
  onGuardRequest: ((request: string) => void) | undefined;

  async capture(argv: readonly string[]): Promise<CommandResult> {
    this.record("capture", argv);
    const key = argv.join(" ");
    if (this.throwingCommands.has(key)) {
      throw new Error(`fake failure: ${key}`);
    }
    if (this.failingCommands.has(key)) {
      return { exitCode: 1, stdout: "", stderr: `failed: ${key}` };
    }
    if (key === "mdutil -s -a") {
      return { exitCode: 0, stdout: this.spotlightOutput, stderr: "" };
    }
    if (isDefaultsRead(argv)) {
      return this.timeMachineResult;
    }
    if (key === "sysctl -n vm.loadavg") {
      return { exitCode: 0, stdout: "{ 2.50 2.00 1.50 }\n", stderr: "" };
    }
    if (key === "ps -A -r -o pcpu=,rss=,pid=,comm=") {
      return {
        exitCode: 0,
        stdout: " 42.0 51200   101 /Applications/Busy App.app/Contents/MacOS/Busy App\n  1.5  2048   202 /usr/sbin/idle\n",
        stderr: "",
      };
    }
    if (key === "tmutil destinationinfo -X") {
      const destinations = this.timeMachineDestinations
        ? "<key>Destinations</key><array><dict></dict></array>"
        : "";
      return {
        exitCode: 0,
        stdout: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${destinations}</dict>\n</plist>\n`,
        stderr: "",
      };
    }
    if (key === "networksetup -listallhardwareports") {
      return { exitCode: 0, stdout: hardwarePorts(this.wifiDevice), stderr: "" };
    }
    if (key === `networksetup -getairportpower ${this.wifiDevice}`) {
      return {
        exitCode: 0,
        stdout: `Wi-Fi Power (${this.wifiDevice}): ${this.wifiPower}\n`,
        stderr: "",
      };
    }
    return OK;
  }

  async interactive(argv: readonly string[]): Promise<CommandResult> {
    this.record("interactive", argv);
    return this.interactiveResult;
  }

  spawn(argv: readonly string[], options?: SpawnOptions): ProcessHandle {
    this.record("spawn", argv);
    const handle = new FakeProcess();
    this.processes.push({ argv: [...argv], handle, options });
    if (argv[0] === "caffeinate") {
      return handle;
    }
    const command = jobCommand(argv);
    if (this.hangingCommands.has(command)) {
      this.hanging.set(command, handle);
      return handle;
    }
    queueMicrotask(() => {
      for (const line of this.jobOutputs.get(command) ?? []) {
        const output: OutputLine = { stream: "stdout", line };
        options?.onOutput?.(output);
      }
      handle.resolve({ exitCode: this.jobResults.get(command) ?? 0, stdout: "", stderr: "" });
    });
    return handle;
  }

  pipe(argv: readonly string[], _options?: { cwd?: string }): PipeProcess {
    this.record("pipe", argv);
    const guard = new FakeGuard();
    guard.onRequest = this.onGuardRequest;
    for (const request of this.guardDieOnRequests) {
      guard.dieOnRequests.add(request);
    }
    for (const [request, result] of this.guardFailures) {
      guard.failingRequests.set(request, result);
    }
    if (this.guardStartFailure !== undefined) {
      guard.failStart(this.guardStartFailure);
    }
    this.guards.push(guard);
    return guard;
  }

  private record(method: FakeCall["method"], argv: readonly string[]): void {
    const copy = [...argv];
    this.calls.push({ method, argv: copy });
    this.onCall?.(copy);
  }
}

function isDefaultsRead(argv: readonly string[]): boolean {
  const words = [...argv];
  while (words[0] === "sudo" || words[0] === "-n") {
    words.shift();
  }
  return (
    words[0] === "defaults" &&
    words[1] === "read" &&
    words[2] === "/Library/Preferences/com.apple.TimeMachine"
  );
}

function hardwarePorts(device: string): string {
  return [
    "Hardware Port: Ethernet",
    "Device: en9",
    "Ethernet Address: aa:bb:cc:dd:ee:ff",
    "",
    "Hardware Port: Wi-Fi",
    `Device: ${device}`,
    "Ethernet Address: 11:22:33:44:55:66",
    "",
  ].join("\n");
}

function jobCommand(argv: readonly string[]): string {
  if (argv[0] === "sh" && argv[1] === "-c") {
    return argv[2] ?? "";
  }
  return argv.join(" ");
}

type TestSession = {
  options: SessionOptions;
  root: string;
  writes: string[];
};

function createSession(
  runner: Runner,
  overrides: Partial<SessionOptions> = {},
): TestSession {
  const root = mkdtempSync(join(tmpdir(), "quiet-session-test-"));
  const writes: string[] = [];
  const options: SessionOptions = {
    runner,
    settings: { spotlight: true, timeMachine: false, wifi: false },
    jobs: [{ name: "job", command: "echo ok", estimateMinutes: 1 }],
    stopOnFailure: false,
    dryRun: false,
    outDir: join(root, "out"),
    cwd: root,
    statePath: join(root, "state", "restore-state.json"),
    sessionId: "20261108-200000",
    startedAt: new Date(2026, 10, 8, 20, 0, 0),
    signalSource: new FakeSignals(),
    write: (text) => writes.push(text),
    now: () => new Date(2026, 10, 8, 20, 1, 0),
    notify: false,
    sudoRefreshIntervalMs: 60_000,
    ...overrides,
  };
  return { options, root, writes };
}

function callsOf(runner: FakeRunner): string[] {
  return runner.calls.map((call) => call.argv.join(" "));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the session");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("prior states are read first and only enabled settings change", async () => {
  const runner = new FakeRunner();
  runner.spotlightOutput = "/:\n\tIndexing enabled. \n/Volumes/Off:\n\tIndexing disabled. \n";
  runner.timeMachineResult = { exitCode: 0, stdout: "1\n", stderr: "" };
  runner.wifiPower = "On";
  runner.jobOutputs.set("echo built", ["built it"]);
  const { options, root } = createSession(runner, {
    settings: { spotlight: true, timeMachine: true, wifi: true },
    jobs: [{ name: "build", command: "echo built", estimateMinutes: 2 }],
  });
  try {
    runner.onGuardRequest = (request) => {
      if (request.startsWith("apply ")) {
        expect(existsSync(options.statePath)).toBe(true);
        const state = JSON.parse(readFileSync(options.statePath, "utf8")) as {
          changes: unknown[];
        };
        expect(state.changes).toHaveLength(3);
      }
    };
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(0);
    const calls = callsOf(runner);
    const guardStart = calls.findIndex((call) => call.startsWith("sudo -n /bin/sh"));
    expect(guardStart).toBeGreaterThan(-1);
    for (const read of [
      "mdutil -s -a",
      TIME_MACHINE_READ,
      "networksetup -listallhardwareports",
      "networksetup -getairportpower en0",
    ]) {
      expect(calls.indexOf(read)).toBeGreaterThan(-1);
      expect(calls.indexOf(read)).toBeLessThan(guardStart);
    }
    const guardCall = runner.calls.find((call) => call.method === "pipe");
    expect(guardCall?.argv).toContain(
      join(options.outDir, "sessions", options.sessionId, "guard.log"),
    );
    const guard = runner.guards[0]!;
    expect(guard.requests).toContain("apply spotlight /");
    expect(guard.requests).not.toContain("apply spotlight /Volumes/Off");
    expect(guard.requests).toContain("apply time-machine");
    expect(guard.requests).toContain("apply wifi en0");
    expect(guard.requests.filter((request) => request === "undo spotlight /")).toHaveLength(1);
    expect(guard.requests.filter((request) => request === "undo time-machine")).toHaveLength(1);
    expect(guard.requests.filter((request) => request === "undo wifi en0")).toHaveLength(1);
    expect(guard.requests[guard.requests.length - 1]).toBe("END");
    expect(calls).not.toContain("sudo mdutil -i off /");
    expect(calls).not.toContain("sudo mdutil -i on /");
    expect(calls.filter((call) => call === "sudo -v")).toHaveLength(1);
    expect(runner.calls.some((call) => call.method === "spawn" && call.argv[0] === "caffeinate")).toBe(true);
    const jobProcess = runner.processes.find((process) => process.argv[0] === "sh");
    expect(jobProcess?.options?.processGroup).toBe(true);
    expect(existsSync(options.statePath)).toBe(false);
    expect(outcome.jobs).toHaveLength(1);
    expect(outcome.restores).toHaveLength(3);
    expect(outcome.restoredAll).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings that are already off are not changed or restored", async () => {
  const runner = new FakeRunner();
  runner.spotlightOutput = "/:\n\tIndexing disabled. \n";
  runner.timeMachineResult = { exitCode: 0, stdout: "0\n", stderr: "" };
  runner.wifiPower = "Off";
  const { options, root } = createSession(runner, {
    settings: { spotlight: true, timeMachine: true, wifi: true },
  });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(0);
    expect(runner.guards).toHaveLength(0);
    const calls = callsOf(runner);
    expect(calls).not.toContain("sudo mdutil -i off /");
    expect(calls).not.toContain("sudo tmutil disable");
    expect(calls.some((call) => call.startsWith("sudo networksetup -setairportpower"))).toBe(false);
    expect(calls.some((call) => call.startsWith("sudo mdutil -i on"))).toBe(false);
    expect(calls).not.toContain("sudo tmutil enable");
    expect(outcome.restores).toHaveLength(0);
    expect(existsSync(options.statePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable Time Machine state is left unchanged", async () => {
  const runner = new FakeRunner();
  runner.timeMachineResult = { exitCode: 1, stdout: "", stderr: "not readable" };
  const { options, root } = createSession(runner, {
    settings: { spotlight: false, timeMachine: true, wifi: false },
  });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(0);
    expect(callsOf(runner).some((call) => call.includes("tmutil disable"))).toBe(false);
    expect(existsSync(options.statePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Time Machine without a destination is left unchanged without reading its preferences", async () => {
  const runner = new FakeRunner();
  runner.timeMachineDestinations = false;
  runner.timeMachineResult = { exitCode: 0, stdout: "1\n", stderr: "" };
  const { options, root } = createSession(runner, {
    settings: { spotlight: false, timeMachine: true, wifi: false },
  });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(0);
    const calls = callsOf(runner);
    expect(calls).toContain("tmutil destinationinfo -X");
    expect(calls.some((call) => call.includes("defaults read"))).toBe(false);
    expect(calls.some((call) => call.includes("tmutil disable"))).toBe(false);
    expect(existsSync(options.statePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed job is recorded and the next job runs by default", async () => {
  const runner = new FakeRunner();
  runner.jobResults.set("exit 1", 1);
  const jobs: JobSpec[] = [
    { name: "bad", command: "exit 1", estimateMinutes: 1 },
    { name: "good", command: "echo good", estimateMinutes: 1 },
  ];
  const { options, root } = createSession(runner, { jobs });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.jobs.map((result) => result.job.name)).toEqual(["bad", "good"]);
    expect(runner.guards[0]!.requests).toContain("undo spotlight /");
    expect(outcome.restoredAll).toBe(true);
    expect(existsSync(options.statePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--stop-on-failure skips the remaining jobs", async () => {
  const runner = new FakeRunner();
  runner.jobResults.set("exit 1", 1);
  const jobs: JobSpec[] = [
    { name: "bad", command: "exit 1" },
    { name: "never", command: "echo never" },
  ];
  const { options, root } = createSession(runner, { jobs, stopOnFailure: true });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.jobs.map((result) => result.job.name)).toEqual(["bad"]);
    expect(callsOf(runner)).not.toContain("sh -c echo never");
    expect(runner.guards[0]!.requests).toContain("undo spotlight /");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thrown error during a change still restores and removes the state file", async () => {
  const runner = new FakeRunner();
  runner.guardDieOnRequests.add("apply spotlight /");
  runner.throwingCommands.add("sudo mdutil -i off /");
  const { options, root } = createSession(runner);
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.jobs).toHaveLength(0);
    expect(callsOf(runner)).toContain("sudo mdutil -i on /");
    expect(outcome.restores).toHaveLength(1);
    expect(outcome.restores[0]?.ok).toBe(true);
    expect(existsSync(options.statePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sudo ticket is refreshed while a job runs", async () => {
  const runner = new FakeRunner();
  const signals = new FakeSignals();
  runner.hangingCommands.add("sleep 60");
  const { options, root } = createSession(runner, {
    settings: { spotlight: false, timeMachine: false, wifi: false },
    jobs: [{ name: "slow", command: "sleep 60" }],
    signalSource: signals,
    sudoRefreshIntervalMs: 10,
  });
  try {
    const running = runSession(options);
    await waitFor(() => runner.hanging.has("sleep 60"));
    await waitFor(() => callsOf(runner).includes("sudo -n -v"));
    signals.emit("SIGINT");
    const outcome = await running;
    expect(outcome.exitCode).toBe(130);
    expect(callsOf(runner).filter((call) => call === "sudo -n -v").length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a signal stops the running job, restores once and exits with the signal code", async () => {
  const runner = new FakeRunner();
  const signals = new FakeSignals();
  runner.hangingCommands.add("sleep 60");
  const { options, root } = createSession(runner, {
    jobs: [{ name: "slow", command: "sleep 60" }],
    signalSource: signals,
  });
  try {
    const running = runSession(options);
    await waitFor(() => runner.hanging.has("sleep 60"));
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    const outcome = await running;
    expect(outcome.exitCode).toBe(130);
    expect(runner.hanging.get("sleep 60")?.stopped).toBe(true);
    expect(runner.guards[0]!.requests.filter((request) => request === "undo spotlight /")).toHaveLength(1);
    expect(outcome.restores).toHaveLength(1);
    expect(existsSync(options.statePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed restore does not stop the others and keeps the state file", async () => {
  const runner = new FakeRunner();
  runner.wifiPower = "On";
  runner.guardFailures.set("undo spotlight /", { exitCode: 1, stdout: "", stderr: "failed" });
  const { options, root } = createSession(runner, {
    settings: { spotlight: true, timeMachine: false, wifi: true },
    notify: true,
  });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).not.toBe(0);
    const guard = runner.guards[0]!;
    expect(guard.requests).toContain("undo spotlight /");
    expect(guard.requests).toContain("undo wifi en0");
    expect(outcome.restores).toHaveLength(2);
    expect(outcome.restores.map((result) => result.ok)).toEqual([true, false]);
    expect(outcome.restoredAll).toBe(false);
    expect(existsSync(options.statePath)).toBe(true);
    expect(runner.calls.some((call) => call.argv[0] === "osascript")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a state file blocks a new session, and restore undoes it and removes the file", async () => {
  const runner = new FakeRunner();
  const { options, root } = createSession(runner);
  const changes: RestoreEntry[] = [
    {
      id: "spotlight:/",
      kind: "spotlight",
      label: "Spotlight /",
      priorState: "on",
      undo: ["sudo", "mdutil", "-i", "on", "/"],
      undoCommand: "sudo mdutil -i on /",
    },
    {
      id: "wifi:en0",
      kind: "wifi",
      label: "Wi-Fi en0",
      priorState: "on",
      undo: ["sudo", "networksetup", "-setairportpower", "en0", "on"],
      undoCommand: "sudo networksetup -setairportpower en0 on",
    },
  ];
  const state = {
    version: 1 as const,
    sessionId: "20261107-120000",
    createdAt: "2026-11-07T11:00:00.000Z",
    changes,
  };
  writeRestoreState(options.statePath, state);
  try {
    const blocked = await runSession(options);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.jobs).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);

    const writes: string[] = [];
    const restoreExit = await runRestoreCommand({
      runner,
      statePath: options.statePath,
      write: (text) => writes.push(text),
    });
    expect(restoreExit).toBe(0);
    const calls = callsOf(runner);
    expect(calls.indexOf("sudo networksetup -setairportpower en0 on")).toBeLessThan(
      calls.indexOf("sudo mdutil -i on /"),
    );
    expect(existsSync(options.statePath)).toBe(false);
    expect(writes.join("")).toContain("sudo mdutil -i on /");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the restore command keeps the state file when an undo fails", async () => {
  const runner = new FakeRunner();
  const { options, root } = createSession(runner);
  runner.failingCommands.add("sudo mdutil -i on /");
  writeRestoreState(options.statePath, {
    version: 1,
    sessionId: "20261107-120000",
    createdAt: "2026-11-07T11:00:00.000Z",
    changes: [
      {
        id: "spotlight:/",
        kind: "spotlight",
        label: "Spotlight /",
        priorState: "on",
        undo: ["sudo", "mdutil", "-i", "on", "/"],
        undoCommand: "sudo mdutil -i on /",
      },
      {
        id: "wifi:en0",
        kind: "wifi",
        label: "Wi-Fi en0",
        priorState: "on",
        undo: ["sudo", "networksetup", "-setairportpower", "en0", "on"],
        undoCommand: "sudo networksetup -setairportpower en0 on",
      },
    ],
  });
  try {
    const exitCode = await runRestoreCommand({
      runner,
      statePath: options.statePath,
      write: () => {},
    });
    expect(exitCode).toBe(1);
    expect(callsOf(runner)).toContain("sudo networksetup -setairportpower en0 on");
    expect(existsSync(options.statePath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a guard that cannot start stops the session before any change", async () => {
  const runner = new FakeRunner();
  runner.guardStartFailure = "sudo: a password is required";
  const { options, root } = createSession(runner);
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.jobs).toHaveLength(0);
    expect(outcome.restores).toHaveLength(0);
    expect(runner.guards).toHaveLength(1);
    expect(runner.guards[0]!.requests).toHaveLength(0);
    expect(callsOf(runner)).not.toContain("sudo mdutil -i off /");
    expect(existsSync(options.statePath)).toBe(false);
    const log = readFileSync(outcome.logPath, "utf8");
    expect(log).toContain("restore guard");
    expect(log).toContain("a password is required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a guard that dies during the session falls back to direct sudo", async () => {
  const runner = new FakeRunner();
  runner.wifiPower = "On";
  runner.guardDieOnRequests.add("apply wifi en0");
  const { options, root } = createSession(runner, {
    settings: { spotlight: true, timeMachine: false, wifi: true },
  });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(0);
    const calls = callsOf(runner);
    expect(calls).toContain("sudo networksetup -setairportpower en0 off");
    expect(calls).toContain("sudo networksetup -setairportpower en0 on");
    expect(calls).toContain("sudo mdutil -i on /");
    expect(outcome.restores).toHaveLength(2);
    expect(outcome.restoredAll).toBe(true);
    expect(existsSync(options.statePath)).toBe(false);
    const log = readFileSync(outcome.logPath, "utf8");
    expect(log).toContain("directly with sudo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a guard that dies during the restore finishes the rest directly", async () => {
  const runner = new FakeRunner();
  runner.wifiPower = "On";
  runner.guardDieOnRequests.add("undo wifi en0");
  const { options, root } = createSession(runner, {
    settings: { spotlight: true, timeMachine: false, wifi: true },
  });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(0);
    const calls = callsOf(runner);
    expect(calls).toContain("sudo networksetup -setairportpower en0 on");
    expect(calls).toContain("sudo mdutil -i on /");
    expect(outcome.restores).toHaveLength(2);
    expect(outcome.restores.every((result) => result.ok)).toBe(true);
    expect(outcome.restoredAll).toBe(true);
    expect(existsSync(options.statePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run reads state but changes no setting and writes no session files", async () => {
  const runner = new FakeRunner();
  runner.spotlightOutput = "/:\n\tIndexing enabled. \n";
  runner.timeMachineResult = { exitCode: 0, stdout: "1\n", stderr: "" };
  runner.wifiPower = "On";
  const { options, root, writes } = createSession(runner, {
    dryRun: true,
    settings: { spotlight: true, timeMachine: true, wifi: true },
    jobs: [{ name: "plan-only", command: "echo planned", estimateMinutes: 3 }],
  });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(0);
    expect(runner.calls.every((call) => call.method === "capture")).toBe(true);
    const calls = callsOf(runner);
    for (const call of calls) {
      const readOnly =
        call === "mdutil -s -a" ||
        call === TIME_MACHINE_READ ||
        call === "tmutil destinationinfo -X" ||
        call === "networksetup -listallhardwareports" ||
        call === "networksetup -getairportpower en0";
      expect(readOnly).toBe(true);
    }
    expect(calls).not.toContain("sudo -v");
    expect(existsSync(options.statePath)).toBe(false);
    expect(existsSync(join(options.outDir, "sessions"))).toBe(false);
    const output = writes.join("");
    expect(output).toContain("plan-only");
    expect(output).toContain("echo planned");
    expect(output).toContain("estimate 3 min");
    expect(output).toContain("Restore guard");
    expect(output).toContain(join(options.outDir, "sessions", options.sessionId, "guard.log"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the log and status files carry job output and the final paths", async () => {
  const runner = new FakeRunner();
  runner.jobOutputs.set("talk", ["hello from the job"]);
  const { options, root } = createSession(runner, {
    settings: { spotlight: false, timeMachine: false, wifi: false },
    jobs: [{ name: "talker", command: "talk", estimateMinutes: 1 }],
  });
  try {
    const outcome = await runSession(options);
    const calls = callsOf(runner);
    expect(
      calls.some(
        (call) =>
          call.startsWith("mdutil") ||
          call.startsWith("defaults") ||
          call.startsWith("networksetup") ||
          call.startsWith("tmutil"),
      ),
    ).toBe(false);
    const log = readFileSync(outcome.logPath, "utf8");
    expect(log).toContain("[talker] hello from the job");
    for (const line of log.split("\n").filter((entry) => entry.length > 0)) {
      expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] /);
    }
    const status = readFileSync(outcome.statusPath, "utf8");
    expect(status).toContain("talker");
    expect(readFileSync(join(options.outDir, "status.txt"), "utf8")).toBe(status);
    expect(status).toContain(outcome.logPath);
    expect(status).toContain(outcome.sessionDir);
    expect(log).toContain(outcome.logPath);
    expect(log).toContain(outcome.sessionDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session samples load and the busiest processes into the session folder", async () => {
  const runner = new FakeRunner();
  const { options, root } = createSession(runner, {
    settings: { spotlight: false, timeMachine: false, wifi: false },
  });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(0);
    const samplesPath = join(outcome.sessionDir, "samples.tsv");
    const [header, ...rows] = readFileSync(samplesPath, "utf8").trim().split("\n");
    const columns = header!.split("\t");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const busiest = Object.fromEntries(columns.map((name, index) => [name, rows[0]!.split("\t")[index]]));
    expect(busiest.load1).toBe("2.50");
    expect(busiest.pid).toBe("101");
    expect(busiest.command).toBe("/Applications/Busy App.app/Contents/MacOS/Busy App");
    expect(readFileSync(outcome.logPath, "utf8")).toContain(samplesPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing sample does not fail the session", async () => {
  const runner = new FakeRunner();
  runner.failingCommands.add("ps -A -r -o pcpu=,rss=,pid=,comm=");
  const { options, root } = createSession(runner, {
    settings: { spotlight: false, timeMachine: false, wifi: false },
  });
  try {
    const outcome = await runSession(options);
    expect(outcome.exitCode).toBe(0);
    const lines = readFileSync(join(outcome.sessionDir, "samples.tsv"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dry run takes no samples", async () => {
  const runner = new FakeRunner();
  const { options, root } = createSession(runner, { dryRun: true });
  try {
    await runSession(options);
    expect(callsOf(runner).some((call) => call.startsWith("ps ") || call.startsWith("sysctl"))).toBe(
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session folder ids get a numeric suffix when the time is taken", () => {
  const root = mkdtempSync(join(tmpdir(), "quiet-session-id-"));
  try {
    const outDir = join(root, "out");
    mkdirSync(join(outDir, "sessions", "20261108-200000"), { recursive: true });
    const startedAt = new Date(2026, 10, 8, 20, 0, 0);
    expect(sessionFolderId(outDir, startedAt)).toBe("20261108-200000-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
