// The version rule: a running engine that is not the installed one draws nothing and says so. Pure.

/** The first x.y.z[-suffix] in the text, e.g. '2.1.295 (Claude Code)' -> '2.1.295'. */
export function parseClaudeVersion(output: string): string | null {
  const m = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)
  return m ? m[1]! : null
}

/** Claude Desktop runs its own engine and updates it apart from the `claude` on PATH, so a mismatch there
 *  says nothing about this session. */
export function versionCheckApplies(entrypoint: string | undefined): boolean {
  return entrypoint !== 'claude-desktop'
}

/** 'current' when the running engine equals `claude --version`. A mismatch stops the mod (it draws nothing). */
export function restartVerdict(running: string | null, installedOutput: string | null): { verdict: 'current' | 'restart needed' | 'unknown'; installed: string | null } {
  const installed = installedOutput === null ? null : parseClaudeVersion(installedOutput)
  if (running === null || installed === null) {
    return { verdict: 'unknown', installed }
  }
  return { verdict: parseClaudeVersion(running) === installed ? 'current' : 'restart needed', installed }
}
