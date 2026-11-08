/** Runs one command with a fixed environment and keeps stdout as raw bytes. */

export type FixedEnvironment = {
  PATH: string;
  HOME: string;
  ZINN_DIR: string;
};

export type SpawnResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
};

export function measuredEnvironment(zinnDir: string): FixedEnvironment {
  return {
    PATH: requireVariable("PATH"),
    HOME: requireVariable("HOME"),
    ZINN_DIR: zinnDir,
  };
}

export async function runWithEnvironment(
  argv: readonly string[],
  options: { cwd: string; environment: FixedEnvironment },
): Promise<SpawnResult> {
  const child = Bun.spawn({
    cmd: [...argv],
    cwd: options.cwd,
    env: options.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout: new Uint8Array(stdout), stderr };
}

function requireVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is not set`);
  }
  return value;
}
