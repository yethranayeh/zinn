const MS_PER_SECOND = 1000;

/** The runtime's name and version, reported the same way by `zinn info`, failure logs and telemetry */
export function currentRuntime() {
  const { bun, node } = process.versions;

  return bun === undefined
    ? { name: "Node" as const, version: node }
    : { name: "Bun" as const, version: bun };
}

/** When this process started and how long it has run, in milliseconds */
export function readRunClock() {
  const elapsedMs = Math.round(process.uptime() * MS_PER_SECOND);
  const now = new Date();

  return { now, elapsedMs, startedAt: new Date(now.getTime() - elapsedMs) };
}
