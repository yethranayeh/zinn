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
  columns?: number;
  /** Redirects stderr while keeping stdin and stdout attached to the terminal. */
  stderrPath?: string;
  runtime?: string;
  cliPath?: string;
};

/**
 * Shared by CLI tests: runs the CLI in a pseudo-terminal, so stdin and stdout are TTYs.
 * stdout and stderr arrive merged, and the terminal's "\r\n" line endings are normalized.
 */
export async function runCliInTerminal(args: Array<string>, options: TerminalRunOptions) {
  const decoder = new TextDecoder();
  const terminalClosed = Promise.withResolvers<void>();
  let output = "";
  let inputSent = false;

  const command = [options.runtime ?? "bun", options.cliPath ?? CLI_PATH, ...args];
  const terminalCommand = options.stderrPath === undefined
    ? command
    : ["/bin/sh", "-c", 'exec 2>"$1"; shift; exec "$@"', "zinn-terminal", options.stderrPath, ...command];
  const proc = Bun.spawn(terminalCommand, {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.columns ?? DEFAULT_TERMINAL_COLUMNS,
      data: (terminal, data) => {
        output += decoder.decode(data, { stream: true });
        const shouldSendInput = options.input !== undefined && options.inputWhen !== undefined
          && !inputSent && output.includes(options.inputWhen);
        if (shouldSendInput) {
          inputSent = true;
          terminal.write(options.input!);
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

  return { output: output.replaceAll("\r\n", "\n"), code };
}
