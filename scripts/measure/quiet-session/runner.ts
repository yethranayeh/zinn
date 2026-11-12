/** Runs every external command, so tests can replace the whole system with a fake. */

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type OutputLine = {
  stream: "stdout" | "stderr";
  line: string;
};

export type SpawnOptions = {
  cwd?: string;
  /** Starts the command in its own process group in the same session. */
  processGroup?: boolean;
  /** Added to the inherited environment. */
  extraEnv?: Record<string, string>;
  onOutput?: (output: OutputLine) => void;
};

export type CaptureOptions = {
  cwd?: string;
  /** Replaces the inherited environment, as measured commands need a fixed one. */
  env?: Record<string, string>;
  /** Sends stdout to /dev/null instead of buffering it, for a command run in a tight loop. */
  discardStdout?: boolean;
};

export type ProcessHandle = {
  readonly pid: number | undefined;
  readonly done: Promise<CommandResult>;
  stop: () => Promise<void>;
};

export type PipeProcess = {
  readonly pid: number | undefined;
  /** Writes one line to the process's stdin. */
  write: (line: string) => Promise<void>;
  /** Reads the next line from the process's stdout. */
  readLine: () => Promise<string>;
  /** Closes stdin, waits for the process and returns its exit code and stderr. */
  close: () => Promise<CommandResult>;
};

export interface Runner {
  /** Runs a command to completion and captures its output. */
  capture: (argv: readonly string[], options?: CaptureOptions) => Promise<CommandResult>;
  /** Runs a command with the terminal attached, so sudo can prompt for a password. */
  interactive: (argv: readonly string[], options?: { cwd?: string }) => Promise<CommandResult>;
  /** Starts a command and streams its output line by line. */
  spawn: (argv: readonly string[], options?: SpawnOptions) => ProcessHandle;
  /** Starts a long-running command with piped stdin and stdout. */
  pipe: (argv: readonly string[], options?: { cwd?: string }) => PipeProcess;
}

// A job that ignores SIGTERM gets SIGKILL after this long.
const STOP_GRACE_MS = 5_000;

// Starts a command in its own process group without leaving the session, so it keeps the terminal.
const PROCESS_GROUP_LAUNCHER = [
  "/usr/bin/perl",
  "-e",
  'setpgrp(0, 0); exec @ARGV or die "exec failed: $!"',
  "--",
] as const;

export function createRunner(): Runner {
  return {
    async capture(argv, options) {
      const child = Bun.spawn({
        cmd: [...argv],
        cwd: options?.cwd,
        env: options?.env,
        stdin: "ignore",
        stdout: options?.discardStdout === true ? "ignore" : "pipe",
        stderr: "pipe",
      });
      const stdoutPromise =
        options?.discardStdout === true || child.stdout === undefined
          ? Promise.resolve("")
          : new Response(child.stdout).text();
      const [stdout, stderr, exitCode] = await Promise.all([
        stdoutPromise,
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    },

    async interactive(argv, options) {
      const child = Bun.spawn({
        cmd: [...argv],
        cwd: options?.cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return { exitCode: await child.exited, stdout: "", stderr: "" };
    },

    spawn(argv, options) {
      const command =
        options?.processGroup === true ? [...PROCESS_GROUP_LAUNCHER, ...argv] : [...argv];
      const child = Bun.spawn({
        cmd: command,
        cwd: options?.cwd,
        env: options?.extraEnv === undefined ? undefined : { ...process.env, ...options.extraEnv },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdoutDone = pump(child.stdout, "stdout", options?.onOutput);
      const stderrDone = pump(child.stderr, "stderr", options?.onOutput);
      const done = (async () => {
        const exitCode = await child.exited;
        await Promise.all([stdoutDone, stderrDone]);
        return { exitCode, stdout: "", stderr: "" };
      })();

      const kill = (signal: NodeJS.Signals) => {
        if (child.exitCode !== null) {
          return;
        }
        try {
          if (options?.processGroup === true && child.pid !== undefined) {
            try {
              process.kill(-child.pid, signal);
            } catch {
              child.kill(signal);
            }
          } else {
            child.kill(signal);
          }
        } catch {
          // The process exited between the check and the signal.
        }
      };

      let stopPromise: Promise<void> | undefined;
      const stop = () => {
        stopPromise ??= (async () => {
          if (child.exitCode !== null) {
            await done;
            return;
          }
          kill("SIGTERM");
          const timer = setTimeout(() => {
            kill("SIGKILL");
          }, STOP_GRACE_MS);
          await done;
          clearTimeout(timer);
        })();
        return stopPromise;
      };

      return { pid: child.pid, done, stop };
    },

    pipe(argv, options) {
      const child = Bun.spawn({
        cmd: [...argv],
        cwd: options?.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let stderrPromise: Promise<string> | undefined;
      let closePromise: Promise<CommandResult> | undefined;

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
            if (pending.length > 0) {
              const line = pending;
              pending = "";
              return line;
            }
            throw new Error("the process closed its output");
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

      const close = (): Promise<CommandResult> => {
        closePromise ??= (async () => {
          stderrPromise ??= new Response(child.stderr).text();
          try {
            child.stdin.end();
          } catch {
            // stdin was already closed.
          }
          const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);
          return { exitCode, stdout: "", stderr };
        })();
        return closePromise;
      };

      return { pid: child.pid, write, readLine, close };
    },
  };
}

/** Emits complete lines from a byte stream, including a final line without a newline. */
async function pump(
  stream: ReadableStream<Uint8Array> | undefined,
  streamName: OutputLine["stream"],
  onOutput: SpawnOptions["onOutput"],
) {
  if (stream === undefined) {
    return;
  }
  const decoder = new TextDecoder();
  let pending = "";
  const emit = (line: string) => {
    onOutput?.({ stream: streamName, line: line.replace(/\r$/, "") });
  };

  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      emit(pending.slice(0, newlineIndex));
      pending = pending.slice(newlineIndex + 1);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    emit(pending);
  }
}
