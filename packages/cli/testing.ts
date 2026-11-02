import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "index.ts");
// task view draws its section separators across the terminal width, so exact-output tests need a fixed one.
const DEFAULT_TERMINAL_COLUMNS = 200;

type TerminalRunOptions = {
  env: Record<string, string | undefined>;
  cwd?: string;
  /** Typed into the terminal after the CLI starts, such as an answer to a prompt. */
  input?: string;
  /** Waits for this terminal output before typing, to exercise an already active prompt. */
  inputWhen?: string;
  /** Runs after inputWhen is observed and before the answer is sent. */
  beforeInput?: () => void | Promise<void>;
  columns?: number;
  /** Redirects stderr while keeping stdin and stdout attached to the terminal. */
  stderrPath?: string;
  runtime?: string;
  cliPath?: string;
};

/** Runs a CLI process with separate stdout and stderr in an explicitly selected environment. */
export function runCli(
  args: Array<string>,
  options: Pick<TerminalRunOptions, "env" | "cwd" | "runtime" | "cliPath"> & { timeoutMs?: number },
) {
  return runProcessAsync([options.runtime ?? "bun", options.cliPath ?? CLI_PATH, ...args], options);
}

/** On Windows, `detached` opens a console window instead of starting a process group. */
const RUNS_IN_OWN_GROUP = process.platform !== "win32";

/** Ends every process in the group, including descendants that would keep the output pipes open. */
function killGroup(pid: number) {
  try {
    // A negative pid signals the whole process group.
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const groupAlreadyGone = (error as NodeJS.ErrnoException).code === "ESRCH";
    if (!groupAlreadyGone) {
      throw error;
    }
  }
}

/** Runs a command with separate stdout and stderr. The timeout ends the command and its descendants, and `code` is null when a signal ended the command. */
export async function runProcessAsync(
  command: Array<string>,
  options: {
    env: Record<string, string | undefined>;
    cwd?: string;
    stdin?: Uint8Array;
    timeoutMs?: number;
  },
) {
  const killsGroupOnTimeout = options.timeoutMs !== undefined && RUNS_IN_OWN_GROUP;
  const proc = Bun.spawn(command, {
    env: options.env,
    cwd: options.cwd,
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe",
    detached: killsGroupOnTimeout,
    // Bun's own timeout only ends the direct child, so POSIX uses the group timer below.
    timeout: killsGroupOnTimeout ? undefined : options.timeoutMs,
  });
  const timer = killsGroupOnTimeout ? setTimeout(() => killGroup(proc.pid), options.timeoutMs) : undefined;

  try {
    const [, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    return { stdout, stderr, code: proc.exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared by CLI tests: runs the CLI in a pseudo-terminal, so stdin and stdout are TTYs.
 * stdout and stderr arrive merged, and the terminal's "\r\n" line endings are normalized.
 */
export async function runCliInTerminal(args: Array<string>, options: TerminalRunOptions) {
  const decoder = new TextDecoder();
  const terminalClosed = Promise.withResolvers<void>();
  let output = "";
  let inputSent = false;
  let pendingInput: Promise<void> | undefined;

  const command = [options.runtime ?? "bun", options.cliPath ?? CLI_PATH, ...args];
  const terminalCommand =
    options.stderrPath === undefined
      ? command
      : [
          "/bin/sh",
          "-c",
          'exec 2>"$1"; shift; exec "$@"',
          "zinn-terminal",
          options.stderrPath,
          ...command,
        ];
  const proc = Bun.spawn(terminalCommand, {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.columns ?? DEFAULT_TERMINAL_COLUMNS,
      data: (terminal, data) => {
        output += decoder.decode(data, { stream: true });
        const shouldSendInput =
          options.input !== undefined &&
          options.inputWhen !== undefined &&
          !inputSent &&
          output.includes(options.inputWhen);
        if (shouldSendInput) {
          inputSent = true;
          pendingInput = Promise.resolve().then(async () => {
            await options.beforeInput?.();
            terminal.write(options.input!);
          });
          void pendingInput.catch(() => proc.kill());
        }
      },
      exit: () => terminalClosed.resolve(),
    },
  });

  if (options.input !== undefined && options.inputWhen === undefined) {
    proc.terminal!.write(options.input);
  }

  const code = await proc.exited;
  await terminalClosed.promise;
  proc.terminal!.close();
  await pendingInput;

  return { output: output.replaceAll("\r\n", "\n"), code };
}
