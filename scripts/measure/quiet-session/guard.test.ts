import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "guard.sh");
const SYSTEM_PATH = "/usr/bin:/usr/sbin:/bin:/sbin";

type Fixture = {
  root: string;
  bin: string;
  recordPath: string;
  logPath: string;
  statePath: string;
  statusPath: string;
  outStatusPath: string;
  child: ReturnType<typeof spawnGuard>;
  write: (line: string) => Promise<void>;
  request: (line: string) => Promise<string>;
  readLine: () => Promise<string>;
  closeInput: () => Promise<void>;
  wait: () => Promise<{ exitCode: number; stderr: string }>;
  records: () => string[];
  cleanup: () => void;
};

function writeFakeCommand(bin: string, name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "$GUARD_RECORD"\n${body}\n`);
  chmodSync(path, 0o755);
}

function spawnGuard(input: {
  root: string;
  bin: string;
  recordPath: string;
  logPath: string;
  statePath: string;
  statusPath: string;
  outStatusPath: string;
  env?: Record<string, string>;
}) {
  const path = `${input.bin}:${SYSTEM_PATH}`;
  return Bun.spawn({
    cmd: [
      "/bin/sh",
      GUARD,
      input.logPath,
      input.statePath,
      input.statusPath,
      input.outStatusPath,
    ],
    cwd: input.root,
    env: {
      ...process.env,
      PATH: path,
      QUIET_SESSION_GUARD_PATH: path,
      GUARD_RECORD: input.recordPath,
      ...input.env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function createFixture(env: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "quiet-session-guard-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const recordPath = join(root, "commands.log");
  const logPath = join(root, "guard.log");
  const statePath = join(root, "restore-state.json");
  const statusPath = join(root, "status.txt");
  const outStatusPath = join(root, "out-status.txt");
  writeFileSync(recordPath, "");
  writeFileSync(logPath, "");
  writeFileSync(statePath, "{}\n");
  writeFileSync(statusPath, "old status\n");
  writeFileSync(outStatusPath, "old status\n");
  writeFakeCommand(
    bin,
    "mdutil",
    [
      'if [ "${MDUTIL_FAIL_UNDO:-0}" = "1" ] && [ "$1" = "-i" ] && [ "$2" = "on" ]; then',
      "  printf 'mdutil failed\\n' >&2",
      "  exit 1",
      "fi",
      "exit 0",
    ].join("\n"),
  );
  writeFakeCommand(bin, "tmutil", "exit 0");
  writeFakeCommand(bin, "networksetup", "exit 0");

  const child = spawnGuard({
    root,
    bin,
    recordPath,
    logPath,
    statePath,
    statusPath,
    outStatusPath,
    env,
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  const readLine = async (): Promise<string> => {
    for (;;) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        pending = pending.slice(newlineIndex + 1);
        return line;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("the guard closed its output");
      }
      if (chunk.value !== undefined) {
        pending += decoder.decode(chunk.value, { stream: true });
      }
    }
  };

  const write = async (line: string): Promise<void> => {
    child.stdin.write(`${line}\n`);
    await child.stdin.flush();
  };

  return {
    root,
    bin,
    recordPath,
    logPath,
    statePath,
    statusPath,
    outStatusPath,
    child,
    write,
    readLine,
    request: async (line) => {
      await write(line);
      return readLine();
    },
    closeInput: async () => {
      child.stdin.end();
      await child.stdin.flush();
    },
    wait: async () => {
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stderr };
    },
    records: () => readFileSync(recordPath, "utf8").split("\n").filter((line) => line.length > 0),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the guard applies and undoes through the protocol", async () => {
  const fixture = createFixture();
  try {
    expect(await fixture.readLine()).toBe("ready");
    expect(await fixture.request("apply spotlight /")).toBe("0 ");
    expect(await fixture.request("apply spotlight /Volumes/My Disk")).toBe("0 ");
    expect(await fixture.request("apply time-machine")).toBe("0 ");
    expect(await fixture.request("apply wifi en0")).toBe("0 ");
    expect(await fixture.request("undo wifi en0")).toBe("0 ");
    expect(await fixture.request("undo time-machine")).toBe("0 ");
    expect(await fixture.request("undo spotlight /Volumes/My Disk")).toBe("0 ");
    expect(await fixture.request("undo spotlight /")).toBe("0 ");
    await fixture.write("END");
    await fixture.closeInput();
    expect((await fixture.wait()).exitCode).toBe(0);
    expect(fixture.records()).toEqual([
      "mdutil -i off /",
      "mdutil -i off /Volumes/My Disk",
      "tmutil disable",
      "networksetup -setairportpower en0 off",
      "networksetup -setairportpower en0 on",
      "tmutil enable",
      "mdutil -i on /Volumes/My Disk",
      "mdutil -i on /",
    ]);
    expect(existsSync(fixture.statePath)).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test("the guard rejects unknown requests and missing arguments", async () => {
  const fixture = createFixture();
  try {
    expect(await fixture.readLine()).toBe("ready");
    for (const request of [
      "apply nonsense /",
      "undo spotlight",
      "sh -c true",
      "apply spotlight -E /",
      "undo wifi -setairportpower",
    ]) {
      expect((await fixture.request(request)).split(" ")[0]).toBe("2");
    }
    await fixture.write("END");
    await fixture.closeInput();
    expect((await fixture.wait()).exitCode).toBe(0);
    expect(fixture.records()).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

test("the guard restores every applied change when its stdin closes without END", async () => {
  const fixture = createFixture();
  try {
    expect(await fixture.readLine()).toBe("ready");
    expect(await fixture.request("apply spotlight /")).toBe("0 ");
    expect(await fixture.request("apply time-machine")).toBe("0 ");
    expect(await fixture.request("apply wifi en0")).toBe("0 ");
    await fixture.closeInput();
    expect((await fixture.wait()).exitCode).toBe(0);
    expect(fixture.records()).toEqual([
      "mdutil -i off /",
      "tmutil disable",
      "networksetup -setairportpower en0 off",
      "networksetup -setairportpower en0 on",
      "tmutil enable",
      "mdutil -i on /",
    ]);
    expect(existsSync(fixture.statePath)).toBe(false);
    const status = readFileSync(fixture.statusPath, "utf8");
    expect(status).toContain("wrapper ended unexpectedly");
    expect(status).toContain("Undo spotlight /: exit 0");
    expect(readFileSync(fixture.outStatusPath, "utf8")).toBe(status);
    const log = readFileSync(fixture.logPath, "utf8");
    expect(log).toContain("apply spotlight /");
    expect(log).toContain("command: mdutil -i off /");
    expect(log).toContain("exit 0");
    for (const line of log.split("\n").filter((entry) => entry.length > 0)) {
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /);
    }
  } finally {
    fixture.cleanup();
  }
});

test("the guard keeps going when one undo fails and keeps the state file", async () => {
  const fixture = createFixture({ MDUTIL_FAIL_UNDO: "1" });
  try {
    expect(await fixture.readLine()).toBe("ready");
    expect(await fixture.request("apply spotlight /")).toBe("0 ");
    expect(await fixture.request("apply time-machine")).toBe("0 ");
    await fixture.closeInput();
    expect((await fixture.wait()).exitCode).toBe(1);
    expect(fixture.records()).toEqual([
      "mdutil -i off /",
      "tmutil disable",
      "tmutil enable",
      "mdutil -i on /",
    ]);
    expect(existsSync(fixture.statePath)).toBe(true);
    const status = readFileSync(fixture.statusPath, "utf8");
    expect(status).toContain("Undo spotlight /: exit 1 mdutil failed");
    expect(status).toContain("Restore state file kept");
    expect(status).toContain("bun run measure:quiet restore");
    expect(readFileSync(fixture.logPath, "utf8")).toContain("run: bun run measure:quiet restore");
  } finally {
    fixture.cleanup();
  }
});

test("the guard ignores SIGHUP", async () => {
  const fixture = createFixture();
  try {
    expect(await fixture.readLine()).toBe("ready");
    expect(await fixture.request("apply spotlight /")).toBe("0 ");
    const pid = fixture.child.pid;
    if (pid === undefined) {
      throw new Error("the guard has no pid");
    }
    process.kill(pid, "SIGHUP");
    await Bun.sleep(50);
    expect(await fixture.request("apply time-machine")).toBe("0 ");
    await fixture.write("END");
    await fixture.closeInput();
    expect((await fixture.wait()).exitCode).toBe(0);
    expect(fixture.records()).toContain("tmutil disable");
  } finally {
    fixture.cleanup();
  }
});

test("the guard restores on SIGTERM", async () => {
  const fixture = createFixture();
  try {
    expect(await fixture.readLine()).toBe("ready");
    expect(await fixture.request("apply spotlight /")).toBe("0 ");
    expect(await fixture.request("apply time-machine")).toBe("0 ");
    const pid = fixture.child.pid;
    if (pid === undefined) {
      throw new Error("the guard has no pid");
    }
    process.kill(pid, "SIGTERM");
    const result = await fixture.wait();
    expect(result.exitCode).toBe(143);
    expect(fixture.records()).toEqual([
      "mdutil -i off /",
      "tmutil disable",
      "tmutil enable",
      "mdutil -i on /",
    ]);
    expect(existsSync(fixture.statePath)).toBe(false);
    expect(readFileSync(fixture.statusPath, "utf8")).toContain("received SIGTERM");
  } finally {
    fixture.cleanup();
  }
});
