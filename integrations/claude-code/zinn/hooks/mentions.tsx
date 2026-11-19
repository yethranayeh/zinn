/**
 * Zinn task keys decorated in the Claude Code transcript
 *
 * This module and ./pane.tsx are the only code that calls `$`, hooks `on(...)` or builds elements.
 * Zero tokens: `ui.render` only. No tool, no prompt section, no `session.append`
 *
 * Reads the store by argv, read-only:
 *  `zinn task list --all --json`, at session.start and on `/zinn refresh`
 *
 * Writes nothing to a Zinn store and nothing under ~/.claude/
 */
import type {
  EngineInterface,
  On,
  PluginOptions,
  SessionStartInput,
  RenderElement,
  RenderInput,
} from "claude-code";
import type { ZinnKeysMap } from "../types/index";
import type { KeyMap, Mention } from "../lib/keys";
import type { Config, EnvReads } from "../lib/config";
import type { Plan } from "../lib/plan";
import type { Span } from "../lib/style";
import type { KeyMapState } from "../lib/state";
import type { RenderRecord } from "../lib/log";
import type { ViewResult } from "../lib/watch";

import { findMentions, parseTaskList } from "../lib/keys";
import { parseConfig } from "../lib/config";
import { planFor, UNDER_INDENT, type ClaimCtx } from "../lib/plan";
import { claimedAway, claimToastText, footerClaimSpans, heldKeys, nextExpiry } from "../lib/claims";
import { failureReason, toState } from "../lib/state";
import {
  appendCapped,
  footerLabelText,
  hasFooterLabel,
  logDirFor,
  logFileFor,
  pinnedStatus,
  renderLine,
  stats,
  statusText,
} from "../lib/log";
import { restartVerdict, versionCheckApplies } from "../lib/version";
import { showKey } from "./pane";
import { VERSION, zinnEnv } from "./client";
import {
  applyViews,
  changedColumns,
  classify,
  newestActivityId,
  readView,
  toastText,
} from "../lib/watch";

// The state contract (types/index.d.ts) and the shape lib/state.ts builds must be the same type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const CONTRACT_MATCHES: Equal<KeyMapState, ZinnKeysMap> = true;
void CONTRACT_MATCHES;

const ZINN_ARGV = ["zinn", "task", "list", "--all", "--json"] as const;
const ACTIVITY_ARGV = ["zinn", "activity", "list", "--limit", "1", "--json"] as const;
const COMMAND = "zinn";
const TICK_MS = 2000;
const FILE_LINES = 20000;
const SEEN_MAX = 500;
const MAP_REF = { plugin: "zinn", key: "map" } as const;
/** A legend is redrawn this long after the first claim it shows runs out. */
const EXPIRY_REDRAW_MS = 1000;
/** The longest gap the idle poll grows to. */
const IDLE_MAX_GAP_MS = 10 * 60_000;

type Dollar = EngineInterface;
type Comp = "AssistantMessage" | "UserMessage";
type MsgEvent = RenderInput<"AssistantMessage"> | RenderInput<"UserMessage">;
type NextFn = (e: MsgEvent) => Promise<RenderElement>;

// Module variables: a hot reload starts them over and session.start runs again.
let cfg: Config | null = null;
let map: KeyMap | null = null;
let mapNote = "key map loading";
let restartPrefix = "";
let logPath: string | null = null;
let pending: string[] = [];
let ownTimes: number[] = [];
let decorated = 0;
let lastStatus: string | null = null; // null: nothing sent yet, so the first call always reaches the engine
let lastProblem = false;
let mapFailed = false;
let logFailed = false;
let invalidateQueued = false;
let loading: Promise<string> | null = null;
// The live key map. Module variables, so a hot reload starts them over.
let wantFull = false;
let wantKeys = new Set<string>();
let draining: Promise<void> | null = null;
let lastActivity: string | null = null;
let polling = false;
// The poll slows while the session is idle: each check without a sign of use doubles the gap to the next.
let pollOn = false;
let pollPeriodMs = 0;
let pollGapMs = 0;
let sinceCheckMs = 0;
const seen = new Map<string, { text: string; at: number }>();
// Keys this session's messages named, for the claim toast. Capped like `seen`.
const mentioned = new Set<string>();
// When the armed claim-expiry redraw fires. Null: none armed.
let expiryAt: number | null = null;
// Keys this session holds, for the footer label. Kept current wherever the map or the clock changes them.
let held: string[] = [];
const t0 = typeof performance !== "undefined" ? performance.now() : 0;
const now = (): number => (typeof performance !== "undefined" ? performance.now() : 0) - t0;
const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 160);

/** A fault the person should read: the engine is not the installed one, the key map did not load, the log failed. */
const hasProblem = (): boolean => restartPrefix !== "" || mapFailed || logFailed;
const statusNow = () => ({
  look: cfg?.look ?? "off",
  enabled: cfg?.enabled ?? true,
  mapNote,
  restart: restartPrefix,
  own: stats(ownTimes),
  decorated,
});

/**
 * The pinned line and the footer label. The line is pinned only while there is a fault (option `statusLine`):
 * the engine draws a pinned line as a notice, so a line that says "all is well" reads as a warning. What says
 * "loaded" is the dim `zinn` among the footer's mode labels. `/zinn` alone says the rest in a toast.
 */
function setStatus($: Dollar): void {
  const problem = hasProblem();
  const text =
    pinnedStatus(cfg?.statusLine ?? "problems", { ...statusNow(), hasProblem: problem }) ?? "";
  if (text !== lastStatus) {
    lastStatus = text;
    $.ui.status(text === "" ? undefined : text);
  }
  if (problem !== lastProblem) {
    lastProblem = problem;
    try {
      $.ui.invalidate("ui.render");
    } catch {
      /* the label shows the old state until the next redraw */
    }
  }
}

async function flush($: Dollar, extra: string[] = []): Promise<void> {
  setStatus($);
  const lines = [...pending, ...extra];
  pending = [];
  if (lines.length === 0 || logPath === null) {
    return;
  }
  try {
    const existing = (await $.fs.exists(logPath)) ? String(await $.fs.read(logPath)) : "";
    await $.fs.write(logPath, appendCapped(existing, lines, FILE_LINES));
  } catch (err) {
    logPath = null; // one failure stops the log. The transcript is never affected
    logFailed = true;
    mapNote += ` (log off: ${errText(err)})`;
  }
}

/** One redraw of this plugin's message sites after `delayMs`; at most one queued. */
function queueInvalidate($: Dollar, delayMs: number): void {
  if (invalidateQueued) {
    return;
  }
  invalidateQueued = true;
  $.clock.after(Math.max(1, Math.ceil(delayMs)) + 20, () => {
    invalidateQueued = false;
    $.ui.invalidate("ui.render");
  });
}

/** Loads (or reloads) the key map. Never throws: a failure leaves no map and says why, once. */
async function loadMap($: Dollar): Promise<string> {
  const a = now();
  let error: string | null = null;
  let line: Record<string, unknown>;
  try {
    const r = await $.process.run([...ZINN_ARGV], {
      timeoutMs: 5000,
      env: await zinnEnv($, "mentions"),
    });
    const ms = Math.round(now() - a);
    if (r.exitCode !== 0 || r.isStdoutTruncated) {
      error = failureReason(r);
      line = { ev: "map", ok: false, ms, error };
    } else {
      try {
        const p0 = now();
        map = parseTaskList(r.stdout);
        void armExpiry($);
        void refreshHeld($);
        line = {
          ev: "map",
          ok: true,
          argv: ZINN_ARGV,
          ms,
          parseMs: Math.round((now() - p0) * 1000) / 1000,
          bytes: r.stdout.length,
          keys: map.keys.size,
          archived: map.archived,
          projects: map.projects.size,
        };
      } catch (err) {
        error = `bad JSON: ${errText(err)}`;
        line = { ev: "map", ok: false, ms, error };
      }
    }
  } catch (err) {
    error = `zinn did not run: ${errText(err)}`;
    line = { ev: "map", ok: false, ms: Math.round(now() - a), error };
  }
  if (error !== null) {
    map = null;
  }
  mapFailed = error !== null;
  mapNote = map === null ? `no decorations (${error})` : `${map.keys.size} keys`;
  const at = new Date(await $.clock.now().catch(() => 0)).toISOString();
  await $.state
    .set(MAP_REF, toState(map, error === null ? at : null, ZINN_ARGV, error))
    .catch(() => undefined);
  return JSON.stringify(line);
}

/**
 * A claim runs out without a write to the store, so no refresh sees it. Redraw the legends just after the
 * earliest live claim in the map expires, then arm for the next one.
 */
async function armExpiry($: Dollar): Promise<void> {
  if (map === null) {
    return;
  }
  const at = await $.clock.now().catch(() => null);
  if (at === null) {
    return;
  }
  const next = nextExpiry([...map.keys.values()].map((i) => i.claim), at);
  if (next === null) {
    return;
  }
  const armedSooner = expiryAt !== null && expiryAt <= next;
  if (armedSooner) {
    return;
  }
  expiryAt = next;
  $.clock.after(next - at + EXPIRY_REDRAW_MS, () => {
    expiryAt = null;
    $.ui.invalidate("ui.render");
    void refreshHeld($);
    void armExpiry($);
  });
}

/** Recomputes the keys this session holds and redraws the footer when they changed. */
async function refreshHeld($: Dollar): Promise<void> {
  if (map === null || cfg === null || !cfg.footerLabel || !cfg.footerClaim) {
    return;
  }
  const [me, at] = await Promise.all([$.session.id().catch(() => null), $.clock.now().catch(() => null)]);
  if (at === null) {
    return;
  }
  const next = heldKeys(map.keys, me, at);
  const isSame = next.length === held.length && next.every((k, i) => k === held[i]);
  if (isSame) {
    return;
  }
  held = next;
  $.ui.invalidate("ui.render");
}

/** What the legend needs to say who holds a task, read only when a mentioned task has a claim. */
async function claimCtx($: Dollar, mentions: readonly Mention[]): Promise<ClaimCtx | undefined> {
  if (!mentions.some((m) => m.info !== null && m.info.claim !== null)) {
    return undefined;
  }
  const [me, at] = await Promise.all([$.session.id().catch(() => null), $.clock.now()]);
  return { me, now: at };
}

/** The tail guard (AssistantMessage only): a key touching the end of a streaming block waits. */
async function tailHeld(
  $: Dollar,
  rid: string,
  text: string,
  rec: { waitMs: number; calls: number },
): Promise<boolean> {
  const w = now();
  const at = await $.clock.now();
  rec.waitMs += now() - w;
  rec.calls++;
  const prev = seen.get(rid);
  if (prev === undefined || prev.text !== text) {
    if (seen.size >= SEEN_MAX) {
      seen.delete(seen.keys().next().value as string);
    }
    seen.set(rid, { text, at });
    queueInvalidate($, cfg!.tailGuardMs);
    return true;
  }
  if (at - prev.at < cfg!.tailGuardMs) {
    queueInvalidate($, cfg!.tailGuardMs - (at - prev.at));
    return true;
  }
  return false;
}

type Props = { text: string; isSummary?: true; isExpanded?: boolean; isFirstOfReply?: boolean };

async function handle(comp: Comp, $: Dollar, e: MsgEvent, next: NextFn): Promise<RenderElement> {
  const start = now();
  const rec = { waitMs: 0, calls: 0 };
  let nextMs = 0;
  const timedNext = async (x: MsgEvent): Promise<RenderElement> => {
    const a = now();
    try {
      return await next(x);
    } finally {
      nextMs += now() - a;
    }
  };
  const props = e.props as Props;
  const text = props.text;
  let did = "pass";
  let why = "";
  let mentions: Mention[] = [];
  let held = 0;
  let fallbacks = 0;
  let result: RenderElement;
  try {
    // Every pass-through is decided before any `$` call (see the top of this file).
    why =
      cfg === null
        ? "not started"
        : !cfg.enabled
          ? "disabled"
          : cfg.look === "off"
            ? "off"
            : map === null
              ? "no map"
              : comp === "UserMessage" && props.isExpanded === true
                ? "expanded"
                : comp === "UserMessage" && !cfg.myPrompts
                  ? "own prompt left"
                  : "";
    if (why !== "") {
      result = await timedNext(e);
    } else {
      const c = cfg!;
      mentions = findMentions(text, map!, { repeat: "first", code: "skip", only: c.only });
      if (
        comp === "AssistantMessage" &&
        c.tailGuardMs > 0 &&
        mentions.some((m) => m.isTail) &&
        (await tailHeld($, e.requestId, text, rec))
      ) {
        held = mentions.filter((m) => m.isTail).length;
        mentions = mentions.filter((m) => !m.isTail);
      }
      for (const m of mentions) {
        if (m.kind === "known" && !mentioned.has(m.key)) {
          if (mentioned.size >= SEEN_MAX) {
            mentioned.delete(mentioned.values().next().value as string);
          }
          mentioned.add(m.key);
        }
      }
      const plan = planFor({
        text,
        markdown: comp === "AssistantMessage",
        mentions,
        look: c.look,
        cfg: c,
        legend: c.legend,
        maxEntries: c.maxEntries,
        claims: c.look === "under" ? await claimCtx($, mentions) : undefined,
      });
      if (plan.kind === "pass") {
        did = held > 0 ? "held" : "plain";
        result = await timedNext(e);
      } else {
        did = "decorated";
        if (plan.kind === "own") {
          fallbacks = plan.fallbacks;
        }
        result = await draw($, e, timedNext, plan, props.isSummary === true);
      }
    }
  } catch (err) {
    did = "error";
    why = errText(err);
    result = await timedNext(e);
  }
  const total = now() - start;
  const own = total - nextMs - rec.waitMs;
  if (did === "decorated") {
    decorated++;
    ownTimes.push(own);
    if (ownTimes.length > 5000) {
      ownTimes = ownTimes.slice(-5000);
    }
  }
  if (logPath !== null) {
    const r: RenderRecord = {
      ev: "render",
      t: now(),
      comp,
      rid: e.requestId.slice(0, 12),
      surface: e.surface,
      look: cfg?.look ?? "off",
      did,
      why,
      len: text.length,
      known: mentions.filter((m) => m.kind === "known").length,
      unknown: mentions.filter((m) => m.kind === "unknown").length,
      held,
      fallbacks,
      ownMs: own,
      waitMs: rec.waitMs,
      calls: rec.calls,
      totalMs: total,
      isSummary: comp === "AssistantMessage" ? props.isSummary === true : null,
      isExpanded: comp === "UserMessage" ? props.isExpanded === true : null,
      isFirstOfReply: comp === "AssistantMessage" ? props.isFirstOfReply === true : null,
      fullscreen: e.viewport?.isFullscreen ?? null,
      columns: e.viewport?.columns ?? null,
    };
    pending.push(renderLine(r));
  }
  return result;
}

/** The placeholder target of the `link` press mode: https draws as a link, `.invalid` never resolves. */
const PLACEHOLDER_HREF = "https://zinn.invalid/";

/** A press on a legend key opens the pane on that task, as `/zinn-show KEY` does. Never throws. */
async function openPane($: Dollar, key: string): Promise<void> {
  try {
    await showKey($, key);
  } catch (err) {
    $.ui.toast(`zinn: could not open ${key} (${errText(err)}). Type /zinn-show ${key}`);
  }
}

async function draw(
  $: Dollar,
  e: MsgEvent,
  next: NextFn,
  plan: Exclude<Plan, { kind: "pass" }>,
  isSummary: boolean,
): Promise<RenderElement> {
  if (plan.kind === "rewrite") {
    return next({ ...e, props: { ...e.props, text: plan.text } } as MsgEvent);
  }
  const { Box, Text, Markdown, Button } = $.ui.resolve(
    e as RenderInput<"AssistantMessage", "terminal">,
  );
  const T = Text as unknown as (p: Record<string, unknown>) => RenderElement;
  const line = (spans: readonly Span[], extra: RenderElement | null = null): RenderElement => (
    <T>
      {spans.length === 0 && extra === null
        ? " "
        : spans.map((sp) =>
            Object.keys(sp.style).length === 0 ? sp.s : <T {...sp.style}>{sp.s}</T>,
          )}
      {extra}
    </T>
  );
  if (plan.kind === "under") {
    // The legend sits in a Box padded to the reply's text column (UNDER_INDENT), so a wrapped continuation
    // line starts there as well. `stacked` is one Text per line.
    const drawn = await next(e);
    // keyPress: the key of a stacked line is a Button or a Markdown link, and a press opens the pane on it.
    const mode = cfg?.keyPress ?? "off";
    const rows = plan.lines.map((l, i) => {
      const key = plan.keys[i] ?? null;
      if (mode === "off" || key === null || l.length < 3) {
        return line(l);
      }
      const press = () => {
        void openPane($, key);
      };
      const ctl =
        mode === "button" ? (
          <Button key={`key:${key}`} plain onPress={press}>
            <T bold>{key}</T>
          </Button>
        ) : (
          <Markdown
            key={`key:${key}`}
            text={`[${key}](${PLACEHOLDER_HREF}${key})`}
            onLinkPress={press}
          />
        );
      return (
        <Box key={`row:${i}`} flexDirection="row">
          {line([l[0]!])}
          {ctl}
          {line(l.slice(2))}
        </Box>
      );
    });
    return (
      <Box flexDirection="column">
        {drawn}
        <Box flexDirection="column" paddingLeft={UNDER_INDENT}>
          {rows}
        </Box>
      </Box>
    );
  }
  // own: the engine marks a summary row with a faint " · summary" after its last line, but not a hook's
  // own tree (AssistantMessage.isSummary), so the mod adds the same words after its last line.
  const mark = isSummary ? <T dimColor>{" · summary"}</T> : null;
  const last = plan.blocks.length - 1;
  const parts = plan.blocks.map((b, i) => {
    const body =
      b.t === "md" ? (
        <Markdown text={b.text} />
      ) : (
        <Box flexDirection="column">
          {b.lines.map((l, k) => line(l, i === last && k === b.lines.length - 1 ? mark : null))}
        </Box>
      );
    return <Box marginBottom={i < last ? 1 : 0}>{body}</Box>;
  });
  const trailing = isSummary && plan.blocks[last]?.t === "md" ? mark : null;
  return (
    <Box flexDirection="column">
      {parts}
      {trailing}
    </Box>
  );
}

// ---- the live key map --------------------------------------------------------------------------------
// Zero tokens: nothing here registers a tool, a prompt section or a command, and nothing the model reads.
// Two triggers feed one queue: a zinn write seen in this session's Bash calls (tool.call, observe-only), and
// the poll. The queue is drained from `$.clock.after(0, ...)`, never inside the hook, so the host is not held.

/** Runs `zinn activity list --limit 1 --json`; the newest id, or null when it cannot be read. */
async function activityHead($: Dollar): Promise<string | null> {
  try {
    const r = await $.process.run([...ACTIVITY_ARGV], {
      timeoutMs: 5000,
      env: await zinnEnv($, "mentions"),
    });
    return r.exitCode === 0 && !r.isStdoutTruncated ? newestActivityId(r.stdout) : null;
  } catch {
    return null;
  }
}

/** Asks for a refresh and arms the timer that drains the queue; returns at once. */
function enqueue($: Dollar, want: { full: true } | { keys: string[] }): void {
  if ("full" in want) {
    wantFull = true;
  } else {
    for (const k of want.keys) wantKeys.add(k);
  }
  try {
    $.clock.after(0, () => {
      void drain($);
    });
  } catch (err) {
    pending.push(JSON.stringify({ ev: "watch", ok: false, error: `clock.after: ${errText(err)}` }));
  }
}

/** One refresh round: the keys by `zinn task view KEY --json`, or the whole map. Never throws. */
async function refreshRound($: Dollar, full: boolean, keys: string[]): Promise<void> {
  const prev = map;
  const a = now();
  let how = full || prev === null ? "full" : "keys";
  if (how === "keys") {
    const results = new Map<string, ViewResult>();
    for (const key of keys) {
      let res: ViewResult;
      try {
        const r = await $.process.run(["zinn", "task", "view", key, "--json"], {
          timeoutMs: 5000,
          env: await zinnEnv($, "mentions"),
        });
        res = readView(key, r);
      } catch (err) {
        res = { kind: "unknown", why: errText(err) };
      }
      // One answer we cannot read means the partial refresh is not certain: the whole map instead.
      if (res.kind === "unknown") {
        how = "full";
        break;
      }
      results.set(key, res);
    }
    if (how === "keys") {
      map = applyViews(prev!, results);
      void armExpiry($);
      void refreshHeld($);
      mapNote = `${map.keys.size} keys`;
      const at = new Date(await $.clock.now().catch(() => 0)).toISOString();
      await $.state.set(MAP_REF, toState(map, at, ZINN_ARGV, null)).catch(() => undefined);
    }
  }
  if (how === "full") {
    pending.push(await reload($));
  }
  pending.push(
    JSON.stringify({
      ev: "watch",
      how,
      keys: how === "keys" ? keys : undefined,
      ms: Math.round(now() - a),
      ok: map !== null,
    }),
  );
  if (cfg?.toastOnChange === true && prev !== null && map !== null) {
    const moved = changedColumns(prev, map);
    if (moved.length > 0) {
      $.ui.toast(toastText(moved));
    }
    const [me, at] = await Promise.all([$.session.id().catch(() => null), $.clock.now().catch(() => 0)]);
    const taken = claimedAway(prev.keys, map.keys, mentioned, me, at);
    if (taken.length > 0) {
      $.ui.toast(claimToastText(taken));
    }
  }
  setStatus($);
  $.ui.invalidate("ui.render");
}

function drain($: Dollar): Promise<void> {
  if (draining !== null) {
    return draining;
  }
  draining = (async () => {
    while (wantFull || wantKeys.size > 0) {
      const full = wantFull;
      const keys = [...wantKeys];
      wantFull = false;
      wantKeys = new Set();
      try {
        await refreshRound($, full, keys);
      } catch (err) {
        pending.push(JSON.stringify({ ev: "watch", ok: false, error: errText(err) }));
      }
    }
    await flush($).catch(() => undefined);
  })().finally(() => {
    draining = null;
  });
  return draining;
}

/** One poll tick: one cheap CLI call; a full refresh only when the newest activity id is not the last seen. */
async function pollTick($: Dollar): Promise<void> {
  if (polling) {
    return;
  }
  polling = true;
  try {
    const id = await activityHead($);
    if (id === null) {
      return;
    }
    if (lastActivity === null) {
      lastActivity = id;
      return;
    }
    if (id !== lastActivity) {
      lastActivity = id;
      enqueue($, { full: true });
    }
  } finally {
    polling = false;
  }
}

/** A turn or a tool call: back to the normal interval, with one check at once when a tick went unchecked. */
function markUse($: Dollar): void {
  if (!pollOn) {
    return;
  }
  pollGapMs = pollPeriodMs;
  const mapIsBehind = sinceCheckMs >= pollPeriodMs;
  if (mapIsBehind) {
    sinceCheckMs = 0;
    void pollTick($).catch(() => undefined);
  }
}

async function readEnv($: Dollar): Promise<EnvReads> {
  // `$.env.get` takes a literal name (validate lists the variables a module reads).
  const none = (): undefined => undefined;
  const [look, legend, maxEntries, keyPress, marks, myPrompts, log, statusLine] = await Promise.all(
    [
      $.env.get("ZINN_MENTIONS_LOOK").catch(none),
      $.env.get("ZINN_MENTIONS_LEGEND").catch(none),
      $.env.get("ZINN_MENTIONS_MAX_ENTRIES").catch(none),
      $.env.get("ZINN_MENTIONS_KEY_PRESS").catch(none),
      $.env.get("ZINN_MENTIONS_MARKS").catch(none),
      $.env.get("ZINN_MENTIONS_MY_PROMPTS").catch(none),
      $.env.get("ZINN_MENTIONS_LOG").catch(none),
      $.env.get("ZINN_MENTIONS_STATUS_LINE").catch(none),
    ],
  );
  return { look, legend, maxEntries, keyPress, marks, myPrompts, log, statusLine };
}

async function versionCheck(
  $: Dollar,
): Promise<{ running: string | null; installed: string | null; verdict: string }> {
  const entrypoint = await $.env.get("CLAUDE_CODE_ENTRYPOINT").catch(() => undefined);
  if (!versionCheckApplies(entrypoint)) {
    const running = await $.session
      .version()
      .then((v) => v.version)
      .catch(() => null);
    return { running, installed: null, verdict: `not applicable (${entrypoint})` };
  }
  const [running, installedOut] = await Promise.all([
    $.session
      .version()
      .then((v) => v.version)
      .catch(() => null),
    $.process
      .run(["claude", "--version"], { timeoutMs: 8000 })
      .then((r) => (r.exitCode === 0 ? r.stdout : null))
      .catch(() => null),
  ]);
  const rv = restartVerdict(running, installedOut);
  return { running, installed: rv.installed, verdict: rv.verdict };
}

/** Reloads the map once at a time; a second /zinn refresh while one runs waits for it. */
function reload($: Dollar): Promise<string> {
  if (loading === null) {
    loading = loadMap($).finally(() => {
      loading = null;
    });
  }
  return loading;
}

/** `HOME`, then Windows' `USERPROFILE`. Empty when neither is readable, which sends the log to the
 *  plugin folder's sibling. Memoised for the load; `register` resets it. */
let homeP: Promise<string | null> | null = null;
async function readHome($: Dollar): Promise<string | null> {
  const clean = (v: string | undefined): string | null =>
    v !== undefined && v.trim() !== "" ? v.trim() : null;
  const home = await $.env.get("HOME").catch(() => undefined);
  if (clean(home) !== null) {
    return clean(home);
  }
  return clean(await $.env.get("USERPROFILE").catch(() => undefined));
}
function homeDir($: Dollar): Promise<string | null> {
  if (homeP === null) {
    homeP = readHome($);
  }
  return homeP;
}

export const registerMentions = (on: On, options: PluginOptions): void => {
  on("session.end", async ($, e, next) => {
    await flush($, [JSON.stringify({ ev: "end", own: stats(ownTimes), decorated })]).catch(
      () => undefined,
    );
    return next(e);
  });

  // Signs of use for the poll. Observe-only: every turn and tool call, the main loop's and each subagent's,
  // passes as it came.
  on("tool.call", async ($, e, next) => {
    markUse($);
    return next(e);
  });
  on("turn.start", async ($, e, next) => {
    markUse($);
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    markUse($);
    return next(e);
  });

  // `/zinn <sub>`: `refresh` reloads the map. It answers with NO text: a command's text is read by the
  // model on the next request, so the answer is a toast and the status line.
  on("command.run", { command: COMMAND }, async ($, e) => {
    const sub = e.args.trim().toLowerCase().split(/\s+/)[0] ?? "";
    if (sub === "refresh") {
      if (cfg !== null && !cfg.enabled) {
        $.ui.toast("zinn is off (userConfig enabled = false)");
        return {};
      }
      const line = await reload($);
      pending.push(line);
      setStatus($);
      $.ui.toast(map === null ? `zinn: ${mapNote}` : `zinn: key map reloaded, ${mapNote}`);
      $.ui.invalidate("ui.render");
      return {};
    }
    // No word, or `status`: what the pinned line said in 0.1.0, on demand and gone again.
    if (sub === "" || sub === "status") {
      $.ui.toast(statusText(statusNow()));
      return {};
    }
    $.ui.toast("zinn: usage /zinn [status | refresh]");
    return {};
  }).catch(($, _e, _next) => {
    // A failing /zinn never runs anything else and never breaks the transcript: one toast, no text.
    $.ui.toast("zinn: /zinn failed. See the status line");
    return {};
  });

  // Observe-only. The call, its command and its result pass through untouched; a zinn WRITE in the command
  // queues a refresh that runs after this hook has returned. Bash only: this mod does not hook PowerShell.
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (cfg === null || !cfg.enabled || cfg.look === "off") {
      return next(e);
    }
    let verdict: ReturnType<typeof classify> = { kind: "none" };
    try {
      verdict = classify(typeof e.command === "string" ? e.command : "");
    } catch {
      verdict = { kind: "full", why: "classifier error" };
    }
    if (verdict.kind === "none") {
      return next(e);
    }
    const result = await next(e);
    if ("deny" in result && result.deny !== undefined) {
      return result;
    } // refused: nothing ran
    try {
      enqueue($, verdict.kind === "keys" ? { keys: verdict.keys } : { full: true });
    } catch {
      /* the poll is the net */
    }
    return result;
  }).catch(($, e, next) => next(e));

  // The footer label: one dim `zinn` among the mode labels at the right of the prompt footer (terminal and
  // desktop draw SessionMode; elsewhere this never fires). It is the one always-on sign that Zinn is loaded;
  // `zinn ✗` while there is a fault. Skipped when a label is already there, so several Zinn mods show one.
  // While this session holds a task, the engine's labels are followed by ` ◆ KEY` in the key's colour: a mode
  // label is a string the engine draws dim, so the coloured part is drawn here. A throw draws the engine's own footer.
  if (options["footerLabel"] !== false) {
    on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
      if (cfg === null || !cfg.enabled || hasFooterLabel(e.props.modes)) {
        return next(e);
      }
      const drawn = next({ ...e, props: { ...e.props, modes: [...e.props.modes, footerLabelText(hasProblem())] } });
      const claim = cfg.footerClaim ? footerClaimSpans(held) : [];
      if (claim.length === 0) {
        return drawn;
      }
      const { Box, Text } = $.ui.resolve(e);
      const T = Text as unknown as (p: Record<string, unknown>) => RenderElement;
      return (
        <Box flexDirection="row">
          {await drawn}
          {claim.map((sp, i) => (sp.color === undefined ? <T key={String(i)} dimColor>{sp.s}</T> : <T key={String(i)} color={sp.color}>{sp.s}</T>))}
        </Box>
      );
    });
  }

  on("ui.render", { component: "AssistantMessage" }, ($, e, next) =>
    handle("AssistantMessage", $, e, next as unknown as NextFn),
  );
  // The UserMessage hook is registered only when it can do something. `register` receives the options
  // before any `$` exists, so the environment variable (`$.env.get`, async) cannot be read here: the hook is
  // skipped when the OPTION itself says `leave` (an explicit option beats the variable, lib/config.ts
  // `pick`), and registered for `from-env` and `decorate`, where it passes an own prompt through untouched
  // while the variable and the default say `leave`. A change of option reloads the plugin, so the choice is
  // always current. A hook cannot be unregistered.
  const promptsOption =
    typeof options["myPrompts"] === "string" ? options["myPrompts"].trim().toLowerCase() : "";
  if (promptsOption !== "leave") {
    on("ui.render", { component: "UserMessage" }, ($, e, next) =>
      handle("UserMessage", $, e, next as unknown as NextFn),
    );
  }
};

/** The part's `session.start`, which register.tsx runs. */
export async function startMentions(
  options: PluginOptions,
  $: Dollar,
  e: SessionStartInput,
): Promise<void> {
  cfg = parseConfig(options, await readEnv($));
  homeP = null;
  const sessionId = await $.session.id().catch(() => "nosession");
  logPath = cfg.log
    ? logFileFor(
        logDirFor($.plugin.root, cfg.logDir, await homeDir($)),
        new Date(await $.clock.now()).toISOString().slice(0, 10),
        sessionId,
      )
    : null;
  await $.state.set(MAP_REF, toState(null, null, ZINN_ARGV, null)).catch(() => undefined);
  let registered = "not registered";
  try {
    const r = await $.command.register({
      name: COMMAND,
      description: "zinn: say what is loaded (/zinn), reload the Zinn key map (/zinn refresh)",
      argumentHint: "[status | refresh]",
    });
    registered = `/${r.command}`;
  } catch (err) {
    registered = `refused: ${errText(err)}`;
  }
  // The version check and the key map run side by side.
  // The poll's baseline is read beside the map load, so a write that lands between the two is seen on the first tick.
  const baseline = cfg.enabled && cfg.pollSeconds > 0 ? activityHead($) : Promise.resolve(null);
  const [v, mapLine] = await Promise.all([
    versionCheck($),
    cfg.enabled
      ? reload($)
      : Promise.resolve(JSON.stringify({ ev: "map", ok: false, skipped: "disabled" })),
  ]);
  // A running engine that is not the installed one draws nothing and says so.
  if (v.verdict === "restart needed") {
    restartPrefix = `RESTART NEEDED (running ${v.running}, installed ${v.installed}): `;
    cfg = { ...cfg, look: "off", lookSource: "stopped" };
  }
  const startLine = JSON.stringify({
    ev: "session",
    mod: `zinn@${VERSION}`,
    surface: e.surface,
    running: v.running,
    installed: v.installed,
    restart: v.verdict,
    look: cfg.look,
    lookSource: cfg.lookSource,
    legend: cfg.legend,
    keyPress: cfg.keyPress,
    maxEntries: cfg.maxEntries,
    marks: cfg.marks,
    titleMax: cfg.titleMax,
    only: cfg.only ? [...cfg.only] : null,
    myPrompts: cfg.myPrompts,
    tailGuardMs: cfg.tailGuardMs,
    command: registered,
  });
  lastActivity = await baseline;
  await flush($, [startLine, mapLine]);
  $.clock.every(TICK_MS, () => {
    void flush($).catch(() => undefined);
  });
  // The poll. Off with pollSeconds 0, when decorations are off, and when the mod stopped itself (RESTART NEEDED).
  // The timer ticks every pollSeconds. A tick checks once the current gap has passed, and each check
  // doubles the gap, up to IDLE_MAX_GAP_MS, until a sign of use resets it.
  pollOn = cfg.enabled && cfg.look !== "off" && cfg.pollSeconds > 0;
  pollPeriodMs = cfg.pollSeconds * 1000;
  pollGapMs = pollPeriodMs;
  sinceCheckMs = 0;
  if (pollOn) {
    const maxGapMs = Math.max(pollPeriodMs, IDLE_MAX_GAP_MS);
    $.clock.every(pollPeriodMs, () => {
      sinceCheckMs += pollPeriodMs;
      if (sinceCheckMs < pollGapMs) {
        return;
      }
      sinceCheckMs = 0;
      pollGapMs = Math.min(pollGapMs * 2, maxGapMs);
      void pollTick($).catch(() => undefined);
    });
  }
  // Sites drawn before the map arrived were passed through (no $ call, no cost): draw them again.
  if (map !== null && cfg.look !== "off" && cfg.enabled) {
    $.ui.invalidate("ui.render");
  }
}
