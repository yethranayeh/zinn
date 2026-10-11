import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "index.ts");
// task view draws its section separators across the terminal width, so exact-output tests need a fixed one.
const DEFAULT_TERMINAL_COLUMNS = 200;

type TerminalRunOptions = {
  env: Record<string, string | undefined>;
  cwd?: string;
  /** Typed into the terminal after the CLI starts, such as an answer to a prompt. */
  input?: string;
  columns?: number;
};

/**
 * Shared by CLI tests: runs the CLI in a pseudo-terminal, so stdin and stdout are TTYs.
 * stdout and stderr arrive merged, and the terminal's "\r\n" line endings are normalized.
 */
export async function runCliInTerminal(args: Array<string>, options: TerminalRunOptions) {
  const decoder = new TextDecoder();
  const terminalClosed = Promise.withResolvers<void>();
  let output = "";

  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.columns ?? DEFAULT_TERMINAL_COLUMNS,
      data: (_terminal, data) => {
        output += decoder.decode(data, { stream: true });
      },
      exit: () => terminalClosed.resolve(),
    },
  });

  if (options.input !== undefined) {
    proc.terminal!.write(options.input);
  }

  const code = await proc.exited;
  await terminalClosed.promise;
  proc.terminal!.close();

  return { output: output.replaceAll("\r\n", "\n"), code };
}
