const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/;

/** A shell block that starts with a shebang is a script file, not a command list. */
export function startsWithShebang(source: string): boolean {
  return source.trimStart().startsWith("#!");
}

/**
 * Splits fenced shell text into commands. A newline is considered a command, except
 *  when it follows a trailing backslash or a heredoc body.
 */
export function splitShellCommands(source: string): string[] {
  const commands: string[] = [];
  let current: string[] = [];
  let heredocDelimiter: string | null = null;
  let insideCommandSubstitution = false;

  const flush = () => {
    if (current.length === 0) {
      return;
    }

    commands.push(current.join("\n"));
    current = [];
    insideCommandSubstitution = false;
  };

  for (const line of source.split(/\r?\n/)) {
    if (heredocDelimiter !== null) {
      current.push(line);

      if (line.trim() === heredocDelimiter) {
        heredocDelimiter = null;
        if (!insideCommandSubstitution) {
          flush();
        }
      }

      continue;
    }

    const continuesPreviousLine = current.at(-1)?.endsWith("\\") ?? false;
    if (line.trim() === "" && !continuesPreviousLine) {
      flush();
      continue;
    }

    current.push(line);

    const heredoc = line.match(HEREDOC_START);
    if (heredoc !== null) {
      heredocDelimiter = heredoc[2]!;
      insideCommandSubstitution = line.includes("$(");
      continue;
    }

    if (line.endsWith("\\")) {
      continue;
    }

    if (insideCommandSubstitution) {
      if (line.includes(")")) {
        insideCommandSubstitution = false;
        flush();
      }
      continue;
    }

    flush();
  }

  flush();
  return commands;
}
