// Declares Claude Code identity to Zinn through the environment of the shell a Bash (or Monitor) call
// starts. Zero tokens: no $.tool.register, no prompt.compose, no command, no drawing. Environment only:
// $.env.set around next(e), with the in-flight guard. The decision is lib/identity.ts.
//
// This module is the version boundary: every $ call is here, lib/ imports nothing
// from the engine. Every $.env name is spelled as a literal, as the engine requires.
//
//   session.start  ZINN_SESSION_ID := $.session.id(), per-loop four unset (also after a hot reload)
//   session.end    reason clear: forget the loops. The next shell call reads the new id
//   classic.SessionStart  fires at start and after /clear (source 'clear'): re-read the id at once.
//                  on the main thread its agent_type is the --agent type (ZINN_AGENT on the main loop)
//   classic.UserPromptSubmit  main thread: agent_type again (a hot reload misses SessionStart)
//   agent.spawn    observe: agentId -> subagentType, resolved model. And HOLD from before the spawn to
//                  the new agent's first turn.step, the window in which its own MCP servers start
//   mcp.connect    another mod's server start: HOLD around it
//   turn.step      observe only (streaming): the loop's model and effort. E is passed on UNCHANGED
//   tool.call      Bash, Monitor, PowerShell (Windows only. Never fires elsewhere): refresh the
//                  session id, mark the call in flight, write what the
//                  guard allows, run next(e), unmark, write again
import type { EngineInterface, Register } from "claude-code";
import {
  MAIN,
  Tracker,
  clean,
  logDirFor,
  logFileFor,
  plan,
  truthy,
  type Declared,
  type Name,
} from "../lib/identity";

type Dollar = EngineInterface;

let tracker = new Tracker();
let last: Partial<Record<Name, string | undefined>> = {};
let known = new Set<Name>();
let writing: Promise<void> = Promise.resolve();
let logPath: string | null = null;
let logLines: string[] = [];
let logWriting: Promise<void> = Promise.resolve();
let denied = 0;
/** agentId -> the hold its start took, released at that agent's first turn.step */
let starting = new Map<string, number>();

const LOG_LINES = 2000;

async function setVar(
  $: Dollar,
  name: Name,
  value: string | undefined,
): Promise<string | undefined> {
  // One literal per name: `claude plugin validate` reads the names off the source. The result is read
  // as unknown on purpose: 2.1.300 declares `Promise<void>`, 2.1.302 `Promise<{ deny? }>`.
  let r: unknown;
  switch (name) {
    case "ZINN_SESSION_ID":
      r = await $.env.set("ZINN_SESSION_ID", value);
      break;
    case "ZINN_THREAD_ID":
      r = await $.env.set("ZINN_THREAD_ID", value);
      break;
    case "ZINN_AGENT":
      r = await $.env.set("ZINN_AGENT", value);
      break;
    case "ZINN_MODEL":
      r = await $.env.set("ZINN_MODEL", value);
      break;
    case "ZINN_EFFORT":
      r = await $.env.set("ZINN_EFFORT", value);
      break;
  }
  const deny = typeof r === "object" && r !== null ? (r as { deny?: unknown }).deny : undefined;
  return typeof deny === "string" ? deny : undefined;
}

/** Brings the environment to what the guard allows NOW. Serialised: each write computes its target when
 *  it runs, so the last write always reflects the latest in-flight set. */
function sync($: Dollar, why: string): Promise<void> {
  const run = async (): Promise<void> => {
    const t = tracker.target();
    const writes = plan(last, known, t.env);
    for (const w of writes) {
      let deny: string | undefined;
      try {
        deny = await setVar($, w.name, w.value);
      } catch (err) {
        deny = err instanceof Error ? err.message : String(err);
      }
      if (deny === undefined) {
        last[w.name] = w.value;
        known.add(w.name);
      } else {
        denied++;
        known.delete(w.name);
        log($, { ev: "deny", name: w.name, why: deny });
      }
    }
    log($, {
      ev: "sync",
      why,
      decision: t.decision,
      loop: t.loop,
      inflight: tracker.inflightCount(),
      env: shown(t.env),
      wrote: writes.map((w) => w.name),
    });
  };
  writing = writing.then(run, run);
  return writing;
}

function shown(env: Declared): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined) {
      o[k] = v;
    }
  return o;
}

/** The session id as the engine reports it. Refreshed on every shell call, so a /clear or an in-process
 *  resume is picked up before the next child starts. */
async function refreshSession($: Dollar): Promise<void> {
  const id = clean(await $.session.id().catch(() => undefined));
  if (id !== tracker.session) {
    if (tracker.session !== undefined) {
      tracker.resetLoops();
    }
    tracker.session = id;
  }
}

function log($: Dollar, rec: Record<string, unknown>): void {
  if (logPath === null) {
    return;
  }
  logLines.push(JSON.stringify({ t: Date.now(), ...rec }));
  if (logLines.length > LOG_LINES) {
    logLines = logLines.slice(-LOG_LINES);
  }
  const path = logPath;
  const run = async (): Promise<void> => {
    await $.fs.write(path, logLines.join("\n") + "\n").catch(() => undefined);
  };
  logWriting = logWriting.then(run, run);
}

async function readHome($: Dollar): Promise<string | undefined> {
  return (
    clean(await $.env.get("HOME").catch(() => undefined)) ??
    clean(await $.env.get("USERPROFILE").catch(() => undefined))
  );
}

/** Ends the start hold of `agentId`, if it still has one. Not awaited: a release only re-enables. */
function release($: Dollar, agentId: string | undefined, why: string): void {
  if (agentId === undefined) {
    return;
  }
  const hold = starting.get(agentId);
  if (hold === undefined) {
    return;
  }
  starting.delete(agentId);
  tracker.end(hold);
  void sync($, `hold end (${why})`);
}

async function shell<T>($: Dollar, agentId: string | undefined, run: () => Promise<T>): Promise<T> {
  // Synchronous: the call is in flight before any await, so two hooks can never both see "alone".
  const id = tracker.begin(agentId);
  try {
    await refreshSession($);
    if (agentId !== undefined && tracker.facts(agentId).agent === undefined) {
      // agent.spawn not seen (a reload mid-run, a spawn answered elsewhere): ask the roster.
      const found = (await $.agent.list().catch(() => [])).find((a) => a.id === agentId);
      if (found !== undefined) {
        tracker.spawned(agentId, found.type, undefined);
      }
    }
    await sync($, "call begin");
    return await run();
  } finally {
    tracker.end(id);
    await sync($, "call end");
  }
}

export const register: Register = (on, options) => {
  const enabled = options["enabled"] !== false;
  // A reload is a fresh module: start from nothing known about the environment.
  tracker = new Tracker();
  last = {};
  known = new Set();
  writing = Promise.resolve();
  logPath = null;
  logLines = [];
  denied = 0;
  starting = new Map();
  if (!enabled) {
    return;
  }

  on("session.start", async ($, e, next) => {
    const wantLog =
      truthy(options["log"]) || truthy(await $.env.get("ZINN_IDENTITY_LOG").catch(() => undefined));
    await refreshSession($);
    tracker.mainFallbackModel = clean(await $.session.model().catch(() => undefined));
    if (wantLog) {
      const dir = logDirFor(options["logDir"], await readHome($));
      logPath =
        dir === null
          ? null
          : logFileFor(dir, new Date().toISOString().slice(0, 10), tracker.session);
    }
    log($, {
      ev: "start",
      session: tracker.session ?? null,
      mainFallbackModel: tracker.mainFallbackModel ?? null,
      interactive: e.isInteractive,
    });
    await sync($, "session.start");
    return next(e);
  }).catch(($, e, next) => next(e));

  on("session.end", async ($, e, next) => {
    const r = await next(e);
    if (e.reason === "clear") {
      // The process goes on under a new id and no session.start fires: drop the old session's loops
      // and its id now, so nothing between here and the next shell call carries the old one.
      tracker.resetLoops();
      tracker.session = undefined;
      for (const h of starting.values()) tracker.end(h);
      starting.clear();
      log($, { ev: "clear", ended: e.sessionId });
      await sync($, "session.end clear");
    }
    return r;
  }).catch(($, e, next) => next(e));

  // The classic (settings) SessionStart reaches a hooks module whether or not a settings hook is
  // configured. It carries what the function event does not: the /clear restart (source 'clear',
  // after which no session.start fires) and, on the main thread of an --agent session, agent_type.
  on("classic.SessionStart", async ($, e, next) => {
    const r = await next(e);
    if (clean(e.agent_id) === undefined) {
      tracker.mainAgent = clean(e.agent_type);
    }
    await refreshSession($);
    log($, {
      ev: "classic.start",
      source: e.source,
      mainAgent: tracker.mainAgent ?? null,
      idAgrees: clean(e.session_id) === tracker.session,
    });
    await sync($, "classic.SessionStart");
    return r;
  }).catch(($, e, next) => next(e));

  on("classic.UserPromptSubmit", async ($, e, next) => {
    const r = await next(e);
    if (clean(e.agent_id) === undefined) {
      tracker.mainAgent = clean(e.agent_type);
    }
    return r;
  }).catch(($, e, next) => next(e));

  on("agent.spawn", async ($, e, next) => {
    // The engine starts an agent definition's own MCP servers after this resolves and before the
    // agent's first model request. Hold from here, so no such server copies another loop's values.
    const hold = tracker.hold();
    let kept = false;
    try {
      await sync($, "spawn begin");
      const r = await next(e);
      if (r.deny === undefined && r.agentId !== undefined) {
        tracker.spawned(r.agentId, e.subagentType, r.model);
        starting.set(r.agentId, hold);
        kept = true;
        log($, { ev: "spawn", agentId: r.agentId, agent: e.subagentType, model: r.model });
      }
      return r;
    } finally {
      if (!kept) {
        tracker.end(hold);
        await sync($, "spawn failed");
      }
    }
  }).catch(($, e, next) => next(e));

  // Another mod's $.mcp.connect starts a server process the same way: hold around it too. The engine's
  // own MCP starts outside agent.spawn (startup, /mcp, a reload) have no hook.
  on("mcp.connect", async ($, e, next) => {
    const hold = tracker.hold();
    try {
      await sync($, "mcp.connect begin");
      return await next(e);
    } finally {
      tracker.end(hold);
      await sync($, "mcp.connect end");
    }
  }).catch(($, e, next) => next(e));

  // Safety release: an agent that ends before any turn.step must not hold forever.
  on("classic.SubagentStop", async ($, e, next) => {
    const r = await next(e);
    release($, clean(e.agent_id), "subagent stop");
    return r;
  }).catch(($, e, next) => next(e));

  // Observe only: the hook never rewrites the request and passes every chunk on as it came.
  on("turn.step", async function* ($, e, next) {
    try {
      tracker.stepped(e.agentId, e.model, e.effort);
      release($, clean(e.agentId), "first step");
      log($, {
        ev: "step",
        loop: e.agentId ?? MAIN,
        model: e.model,
        effort: e.effort ?? null,
        index: e.index,
      });
    } catch {
      // never let the observation stand between the engine and its model
    }
    return yield* next(e);
  });

  // A failed hook's .catch gets a replay-safe next: when the call already ran, next(e) answers what it
  // settled to and nothing runs twice; when it had not, it runs once.
  on("tool.call", { tool: "Bash" }, ($, e, next) => shell($, e.agentId, () => next(e))).catch(
    ($, e, next) => next(e),
  );
  on("tool.call", { tool: "Monitor" }, ($, e, next) => shell($, e.agentId, () => next(e))).catch(
    ($, e, next) => next(e),
  );
  // Windows' shell tool (CLAUDE_CODE_USE_POWERSHELL_TOOL). Same guard: its child inherits the same
  // process environment. A RegExp, because the tool-name union lists only this platform's tools (Linux
  // declarations have no PowerShell). Not yet run on Windows.
  on("tool.call", { tool: /^PowerShell$/ }, ($, e, next) =>
    shell($, e.agentId, () => next(e)),
  ).catch(($, e, next) => next(e));
};
