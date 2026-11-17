// The pure half. Which ZINN_* values a Bash child may be given, decided from what the hooks module has
// observed. No import from the engine.
//
// The contract is Zinn's (https://zinn.sh/docs/cli/identity):
//   ZINN_SESSION_ID  the conversation, shared by its subagents. Process-wide, no race
//   ZINN_THREAD_ID   the loop that ran the command: a subagent's agentId, unset on the main loop
//   ZINN_AGENT       the loop's agent type (agent.spawn's subagentType). On the main loop the --agent
//                    type (classic SessionStart's agent_type), unset when the session runs none
//   ZINN_MODEL       the loop's latest turn.step model
//   ZINN_EFFORT      the loop's latest turn.step effort, unset for a model without effort
//
// The per-loop four live in ONE process environment ($.env.set), which every child started after a
// write inherits. A child's environment is copied when it is spawned (measured),
// so the only danger is a child spawning while the environment holds ANOTHER loop's values. The rule
// that prevents it (the in-flight guard): the per-loop values are those of the one loop that owns
// every shell call in flight, and unset when calls of two or more loops are in flight, or none is.
// A wrong attribution is worse than a missing one.

export const MAIN = "main" as const;
/** The owner key of a subagent start in progress (agent.spawn until that agent's first turn.step). It is
 *  never a loop: while one is held nothing per-loop is declared, because the engine starts the new
 *  agent's own MCP servers in that window and they would keep whatever loop the environment named
 *  (measured). */
export const HOLD = "\u0000spawning" as const;

/** What a loop has been seen to be. Every field may still be unknown. */
export type LoopFacts = {
  /** agent.spawn's subagentType. Never set for the main loop */
  agent?: string;
  /** turn.step's model, else (until a step) the spawn result's model */
  model?: string;
  /** whether `model` came from a turn.step (true) or a fallback (false) */
  modelFromStep?: boolean;
  /** turn.step's effort as its word (a number budget as its decimal text) */
  effort?: string;
};

/** The five variables, each a value to set or undefined to unset. */
export type Declared = {
  ZINN_SESSION_ID: string | undefined;
  ZINN_THREAD_ID: string | undefined;
  ZINN_AGENT: string | undefined;
  ZINN_MODEL: string | undefined;
  ZINN_EFFORT: string | undefined;
};

export type Decision = "idle" | "declared" | "conflict" | "held" | "no-session";

/** A trimmed non-blank string, else undefined (Zinn treats blank as unset). */
export function clean(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  if (typeof v !== "string") {
    return undefined;
  }
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** The loop key a call or a step belongs to: its agentId, or MAIN when absent. */
export function loopOf(agentId: unknown): string {
  return clean(agentId) ?? MAIN;
}

export class Tracker {
  private loops = new Map<string, LoopFacts>();
  private inflight = new Map<number, string>();
  private seq = 0;
  session: string | undefined = undefined;
  /** the main loop's model from $.session.model(), used only until a main-loop step is seen */
  mainFallbackModel: string | undefined = undefined;
  /** the main loop's agent type in an `--agent` session (classic SessionStart's agent_type). Kept over /clear */
  mainAgent: string | undefined = undefined;

  /** agent.spawn answered: remember the type and the resolved model for that agentId. */
  spawned(agentId: unknown, subagentType: unknown, model: unknown): void {
    const id = clean(agentId);
    if (id === undefined) {
      return;
    }
    const f = this.facts(id);
    const t = clean(subagentType);
    if (t !== undefined) {
      f.agent = t;
    }
    const m = clean(model);
    if (m !== undefined && f.modelFromStep !== true) {
      f.model = m;
      f.modelFromStep = false;
    }
  }

  /** A turn.step is about to be sent: its model and effort are the loop's current ones. */
  stepped(agentId: unknown, model: unknown, effort: unknown): void {
    const f = this.facts(loopOf(agentId));
    const m = clean(model);
    if (m !== undefined) {
      f.model = m;
      f.modelFromStep = true;
    }
    // Absent effort means "this model takes none": the variable is then unset, not left stale.
    f.effort = clean(effort);
  }

  /** A shell call starts in a loop. Synchronous, so two calls never interleave here. Returns its id. */
  begin(agentId: unknown): number {
    const id = ++this.seq;
    this.inflight.set(id, loopOf(agentId));
    return id;
  }

  /** A subagent start begins: nothing per-loop is declared until hold's end(). */
  hold(): number {
    const id = ++this.seq;
    this.inflight.set(id, HOLD);
    return id;
  }

  end(id: number): void {
    this.inflight.delete(id);
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  /** The loops that own the calls in flight now. */
  inflightLoops(): string[] {
    return [...new Set(this.inflight.values())];
  }

  /** Forgets every loop (a /clear or a new session: the old agentIds belong to the old conversation). */
  resetLoops(): void {
    this.loops.clear();
  }

  facts(loop: string): LoopFacts {
    let f = this.loops.get(loop);
    if (f === undefined) {
      f = {};
      this.loops.set(loop, f);
    }
    return f;
  }

  /** What the environment should hold now, and why. */
  target(): { decision: Decision; loop: string | null; env: Declared } {
    const none: Declared = {
      ZINN_SESSION_ID: this.session,
      ZINN_THREAD_ID: undefined,
      ZINN_AGENT: undefined,
      ZINN_MODEL: undefined,
      ZINN_EFFORT: undefined,
    };
    const loops = this.inflightLoops();
    if (loops.length === 0) {
      return { decision: "idle", loop: null, env: none };
    }
    if (loops.includes(HOLD)) {
      return { decision: "held", loop: null, env: none };
    }
    if (loops.length > 1) {
      return { decision: "conflict", loop: null, env: none };
    }
    const loop = loops[0]!;
    // Rule 1: a thread is never declared without its session. With no session id, nothing per-loop is.
    if (this.session === undefined) {
      return { decision: "no-session", loop, env: none };
    }
    const f = this.loops.get(loop) ?? {};
    const model = f.model ?? (loop === MAIN ? this.mainFallbackModel : undefined);
    if (loop === MAIN) {
      return {
        decision: "declared",
        loop,
        env: { ...none, ZINN_AGENT: this.mainAgent, ZINN_MODEL: model, ZINN_EFFORT: f.effort },
      };
    }
    return {
      decision: "declared",
      loop,
      env: {
        ...none,
        ZINN_THREAD_ID: loop,
        ZINN_AGENT: f.agent,
        ZINN_MODEL: model,
        ZINN_EFFORT: f.effort,
      },
    };
  }
}

/** Names in the order they are written. Setting: session first, so a thread never stands without it.
 *  Unsetting the session: the per-loop four first, for the same reason. */
export const NAMES = [
  "ZINN_SESSION_ID",
  "ZINN_THREAD_ID",
  "ZINN_AGENT",
  "ZINN_MODEL",
  "ZINN_EFFORT",
] as const;
export type Name = (typeof NAMES)[number];

/** The writes that take `last` (what the environment is known to hold. Undefined entry = unknown) to
 *  `want`, in a safe order. A name whose last value is unknown is always written. */
export function plan(
  last: Partial<Record<Name, string | undefined>>,
  known: ReadonlySet<Name>,
  want: Declared,
): { name: Name; value: string | undefined }[] {
  const order: readonly Name[] =
    want.ZINN_SESSION_ID === undefined ? [...NAMES.slice(1), "ZINN_SESSION_ID"] : NAMES;
  const out: { name: Name; value: string | undefined }[] = [];
  for (const n of order) {
    if (known.has(n) && last[n] === want[n]) {
      continue;
    }
    out.push({ name: n, value: want[n] });
  }
  return out;
}

/** The log folder: configured, else `<home>/.zinn/traces/zinn-identity`, else null (no log). Never
 *  inside the plugin folder: a write there hot-reloads a --plugin-dir session (zinn-keys' lib/log.ts). */
export function logDirFor(configured: unknown, home: string | undefined): string | null {
  const c = clean(configured);
  if (c !== undefined) {
    return c.replace(/[\\/]+$/, "");
  }
  const h = clean(home);
  return h === undefined ? null : `${h.replace(/[\\/]+$/, "")}/.zinn/traces/zinn-identity`;
}

export function logFileFor(dir: string, day: string, sessionId: string | undefined): string {
  const s = (sessionId ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "nosession";
  return `${dir}/${day}_${s}.jsonl`;
}

/** Option and variable parsing: a boolean option, or the variable's 1/true/on. */
export function truthy(v: unknown): boolean {
  if (typeof v === "boolean") {
    return v;
  }
  const s = clean(v)?.toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}
