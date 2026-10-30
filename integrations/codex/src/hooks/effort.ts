import { closeSync, openSync, readFileSync, fstatSync } from "node:fs";

export type Execution = {
  session_id?: unknown;
  agent_id?: unknown;
  turn_id?: unknown;
  model?: unknown;
  transcript_path?: unknown;
};
export type EffortLookup = {
  effort: string | null;
  outcome: "matched" | "unavailable" | "ambiguous" | "mismatch";
};

const unknown: EffortLookup = { effort: null, outcome: "unavailable" };
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

// Match exact execution metadata without a last-turn or temporal fallback.
export function fromTranscript(transcript: string, execution: Execution): EffortLookup {
  const thread = text(execution.agent_id) ?? text(execution.session_id);
  const turn = text(execution.turn_id);
  const model = text(execution.model);

  if (thread === null || turn === null || model === null) {
    return unknown;
  }

  let identity: unknown;
  let hasHeader = false;
  const contexts: Record<string, unknown>[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      return unknown;
    }

    if (!hasHeader) {
      if (row?.type !== "session_meta") {
        return unknown;
      }
      identity = row.payload?.id;
      hasHeader = true;
    }

    // Forked child history can contain copied parent headers after the file's own header.
    if (row?.type === "turn_context" && row.payload?.turn_id === turn) {
      contexts.push(row.payload);
    }
  }

  if (contexts.length > 1) {
    return { effort: null, outcome: "ambiguous" };
  }

  if (!hasHeader || contexts.length !== 1) {
    return unknown;
  }

  if (identity !== thread || contexts[0]!.model !== model) {
    return { effort: null, outcome: "mismatch" };
  }

  const effort = text(contexts[0]!.effort);
  return effort === null ? unknown : { effort, outcome: "matched" };
}

export function lookupEffort(execution: Execution): EffortLookup {
  const path = text(execution.transcript_path);
  if (path === null) {
    return unknown;
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_TRANSCRIPT_BYTES) {
      return unknown;
    }

    return fromTranscript(readFileSync(descriptor, "utf8"), execution);
  } catch {
    return unknown;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}
