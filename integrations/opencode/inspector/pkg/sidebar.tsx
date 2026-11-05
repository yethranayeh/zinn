/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import type { PanelSnapshot } from "./commands.ts";
import type { InspectorOptions } from "./options.ts";
import type { DisplayRow } from "./rows.ts";
import type { ScanCache } from "./scan.ts";
import type { Ctx, Loaded, Scan, TaskSummary } from "./types.ts";

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { clearPanel, publishPanel } from "./commands.ts";
import { Overflow, RailLine, Row } from "./components.tsx";
import { openDetail, openPicker } from "./dialogs.tsx";

import { columnGlyph, rowTone, stableRows, truncate } from "./rows.ts";
import { mentionCounts, newestIdleID, scanSession } from "./scan.ts";
import {
  PROBE_CONCURRENCY,
  activityProbesSupported,
  disableActivityProbes,
  probeAnySession,
  probeSessions,
  runPool,
  sessionRunning,
} from "./session.ts";
import {
  PRIORITY_COLUMNS,
  RAIL_COLUMNS,
  RUNNING_FRAMES,
  RUNNING_INTERVAL,
  SECTION_ROWS,
  SLOT_COLUMNS,
} from "./options.ts";
import { inspectorTheme } from "./theme.ts";
import {
  BOARD_TTL_MS,
  errorText,
  flaggedFor,
  loadKeyMap,
  log,
  refreshKeyMap,
  shouldReadBoard,
} from "./data.ts";

export function Sidebar(props: {
  ctx: Ctx;
  sessionID: string;
  options: InspectorOptions;
}): JSX.Element {
  const theme = () => inspectorTheme(props.ctx);
  const [map, setMap] = createSignal<Loaded<Map<string, TaskSummary>>>({
    ok: false,
    error: "Zinn unavailable",
  });
  const [loading, setLoading] = createSignal(true);
  const [boardSeq, setBoardSeq] = createSignal(0);
  let alive = true;
  let probeCycle = 0;
  const [baselineReady, setBaselineReady] = createSignal(false);
  let lastIdleID: string | undefined;
  let lastBoardReadAt = 0;
  let lastBoardReadZinn = 0;

  const apply = (result: Loaded<Map<string, TaskSummary>>, reason: string) => {
    if (!alive) {
      return;
    }

    if (result.ok) {
      log(props.ctx, "board keys loaded", { reason, keys: result.value.size });
    } else {
      log(props.ctx, "board keys failed", { reason, error: result.error });
    }

    setMap(result);
    setLoading(false);
    setBoardSeq((n) => n + 1);
    if (result.ok) {
      lastBoardReadAt = Date.now();
      lastBoardReadZinn = untrack(() => scan().zinnCommands);
    }
  };

  // Merge overlapping refresh requests into one read.
  let refreshInflight: Promise<void> | undefined;
  const refresh = (reason: string, showLoading: boolean, forceLabels = false): Promise<void> => {
    if (!alive) {
      return Promise.resolve();
    }

    if (refreshInflight !== undefined) {
      return refreshInflight;
    }

    const run = (async () => {
      if (showLoading) {
        setLoading(true);
      }

      try {
        await props.ctx.data.session.message.sync(props.sessionID);
      } catch (error) {
        log(props.ctx, "message sync failed", { reason, error: errorText(error) });
      }

      if (!alive) {
        return;
      }

      const zinnTotal = untrack(() => scan().zinnCommands);
      const msSinceRead = Date.now() - lastBoardReadAt;
      const force = reason !== "turn ended";
      if (
        !shouldReadBoard({
          force,
          zinnTotal,
          lastReadZinn: lastBoardReadZinn,
          msSinceRead,
          ttl: BOARD_TTL_MS,
        })
      ) {
        log(props.ctx, "board read skipped", {
          reason,
          zinnTotal,
          lastReadZinn: lastBoardReadZinn,
          msSinceRead,
        });
        if (showLoading) {
          setLoading(false);
        }
        return;
      }
      const result = await refreshKeyMap(forceLabels);
      apply(result, reason);
    })().finally(() => {
      if (refreshInflight === run) {
        refreshInflight = undefined;
      }
    });
    refreshInflight = run;
    return run;
  };

  const reload = () => {
    void refresh("header click", true, true);
  };

  onMount(() => {
    log(props.ctx, "sidebar mounted", { session: props.sessionID });
    onCleanup(() => {
      alive = false;
      probeCycle += 1;
      clearPanel(published);
    });
    void (async () => {
      try {
        await props.ctx.data.session.message.sync(props.sessionID);
      } catch (error) {
        log(props.ctx, "message sync failed", { reason: "mount", error: errorText(error) });
      }
      if (!alive) {
        return;
      }
      lastIdleID = newestIdleID(props.ctx.data.session.message.list(props.sessionID));
      setBaselineReady(true);
      const result = await loadKeyMap();
      apply(result, "mount");
    })();
  });

  createEffect(() => {
    if (!baselineReady()) {
      return;
    }
    const newest = newestIdleID(props.ctx.data.session.message.list(props.sessionID));
    if (newest === undefined || newest === lastIdleID) {
      return;
    }
    lastIdleID = newest;
    void refresh("turn ended", false);
  });

  const running = () => sessionRunning(props.ctx, props.sessionID);
  const [frame, setFrame] = createSignal(0);

  createEffect(() => {
    void props.ctx.data.session.message.list(props.sessionID).length;
    if (props.options.current !== "glyph" || !running()) {
      setFrame(0);
      return;
    }

    const timer = setInterval(() => {
      if (!running()) {
        clearInterval(timer);
        setFrame(0);
        return;
      }
      setFrame((current) => (current + 1) % RUNNING_FRAMES.length);
    }, RUNNING_INTERVAL);
    onCleanup(() => clearInterval(timer));
  });

  const scanCache: ScanCache = { byID: new Map(), computes: 0 };
  const scan = createMemo<Scan>(() => {
    const loaded = map();
    if (!loaded.ok) {
      return {
        known: [],
        unknown: [],
        tokens: 0,
        textParts: 0,
        streamingParts: 0,
        zinnCommands: 0,
        ms: 0,
      };
    }
    const result = scanSession(props.ctx, props.sessionID, loaded.value, scanCache);
    const flagged = flaggedFor(props.sessionID);
    for (const mention of result.unknown) {
      flagged.add(mention.key);
    }
    return result;
  });

  let lastScanSig = "";
  createEffect(() => {
    const result = scan();
    const sig = `${result.tokens}|${result.textParts}|${result.streamingParts}|${result.known.map((m) => m.key).join(",")}`;
    if (sig === lastScanSig) {
      return;
    }

    lastScanSig = sig;
    log(props.ctx, "scan", {
      tokens: result.tokens,
      known: result.known.length,
      unknown: result.unknown.length,
      unknownKeys: result.unknown.map((m) => m.key),
      textParts: result.textParts,
      streamingParts: result.streamingParts,
      ms: result.ms,
    });
  });

  const createdKeys = createMemo<ReadonlySet<string>>(() => {
    const loaded = map();
    if (!loaded.ok) {
      return new Set<string>();
    }

    const flagged = flaggedFor(props.sessionID);
    const out = new Set<string>();

    for (const key of flagged) {
      if (loaded.value.has(key)) {
        out.add(key);
      }
    }
    return out;
  });

  const [mineKeyMap, setMineKeyMap] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  let lastProbeSig = "";
  let lastSessionsSig = "";

  createEffect(() => {
    if (!activityProbesSupported) {
      return;
    }
    if (props.options.current === "off") {
      return;
    }
    const sessions = probeSessions(props.ctx, props.sessionID);
    const sessionsSig = sessions.join(",");
    if (sessionsSig !== lastSessionsSig) {
      lastSessionsSig = sessionsSig;
      log(props.ctx, "current-session probe set", { sessions });
    }
    const keys = visibleKnown().map((row) => row.key);
    const sig = `${sessionsSig}|${boardSeq()}|${keys.join(",")}`;
    if (sig === lastProbeSig) {
      return;
    }
    lastProbeSig = sig;
    // Activity matches persist for this session family. Recheck only unmarked tasks.
    const marked = untrack(() => mineKeyMap());
    const pending = keys.filter((key) => marked.get(key) !== true);
    const cycle = ++probeCycle;
    if (pending.length === 0) {
      return;
    }
    // Keep existing marks while new reads settle, avoiding transient blank states.
    const settled = new Map<string, boolean>();
    for (const [key, value] of marked) {
      if (value === true) {
        settled.set(key, true);
      }
    }
    let degraded = false;
    void runPool(
      pending,
      PROBE_CONCURRENCY,
      async (key) => {
        const probe = await probeAnySession(sessions, key);
        if (!alive || cycle !== probeCycle) {
          return;
        }
        if (probe.unsupported) {
          degraded = true;
          return;
        }
        if (probe.mine) {
          if (settled.get(key) === true) {
            return;
          }
          settled.set(key, true);
        } else {
          if (settled.get(key) !== true) {
            return;
          }
          settled.delete(key);
        }
        setMineKeyMap(new Map(settled));
      },
      () => !alive || cycle !== probeCycle,
    ).then(() => {
      if (!alive || cycle !== probeCycle) {
        return;
      }
      log(props.ctx, "activity probes settled", { matches: [...settled.keys()] });
      if (!degraded) {
        return;
      }
      disableActivityProbes();
      log(
        props.ctx,
        "Zinn rejected the activity session filter. The current-session mark requires Zinn 0.41.0 or newer.",
        { sessions },
      );
    });
  });
  const knownRowCache = new Map<string, DisplayRow>();
  const unknownRowCache = new Map<string, DisplayRow>();

  const knownRows = createMemo<DisplayRow[]>(() => {
    const loaded = map();
    const created = createdKeys();
    const mineKeys = mineKeyMap();
    const candidates = scan().known.map((mention): DisplayRow => {
      const summary = loaded.ok ? loaded.value.get(mention.key) : undefined;
      const isCreated = created.has(mention.key);
      const column = summary?.column ?? "";
      const priority = summary?.priority ?? null;
      const labels = summary?.labels ?? [];
      const mine = mineKeys.get(mention.key) === true;
      return {
        key: mention.key,
        title: summary?.title ?? "",
        priority,
        labels,
        column,
        glyph: isCreated ? "+" : columnGlyph(summary?.column ?? ""),
        tone: rowTone(column, false, isCreated),
        unknown: false,
        created: isCreated,
        mine,
      };
    });
    return stableRows(knownRowCache, candidates);
  });
  const unknownRows = createMemo<DisplayRow[]>(() => {
    const candidates = scan().unknown.map(
      (mention): DisplayRow => ({
        key: mention.key,
        title: "",
        glyph: "⚠",
        tone: "warning",
        unknown: true,
        created: false,
        mine: false,
        priority: null,
        labels: [],
        column: "",
      }),
    );
    return stableRows(unknownRowCache, candidates);
  });
  const mentionCountsByKey = createMemo(() => mentionCounts(scan().known));
  const open = (key: string, unknown: boolean) =>
    openDetail(props.ctx, key, unknown, mentionCountsByKey(), props.sessionID);
  const visibleKnown = createMemo(() => knownRows().slice(0, SECTION_ROWS));
  const knownOverflow = createMemo(() => knownRows().length - visibleKnown().length);
  const visibleUnknown = createMemo(() => unknownRows().slice(0, SECTION_ROWS));
  const unknownOverflow = createMemo(() => unknownRows().length - visibleUnknown().length);
  const titleColumns = createMemo(() => {
    const rows = [...visibleKnown(), ...visibleUnknown()];
    let key = 0;
    for (const row of rows) {
      key = Math.max(key, row.key.length);
    }
    const gaps = props.options.rows === 2 ? 2 : 3;
    const priority = props.options.rows === 2 ? 0 : PRIORITY_COLUMNS;
    return Math.max(8, SLOT_COLUMNS - RAIL_COLUMNS - priority - key - gaps);
  });
  const metaColumns = Math.max(8, SLOT_COLUMNS - RAIL_COLUMNS - 1);
  let published: PanelSnapshot | undefined;
  createEffect(() => {
    const loaded = map();
    published = {
      map: loaded.ok ? loaded.value : undefined,
      known: scan().known,
      sessionID: props.sessionID,
    };
    publishPanel(published);
  });
  const headerDetail = createMemo(() => {
    if (loading()) {
      return "loading…";
    }
    const loaded = map();
    if (!loaded.ok) {
      return truncate(loaded.error, 32);
    }
    const count = loaded.value.size;
    return `${count} ${count === 1 ? "task" : "tasks"}`;
  });
  const failure = createMemo(() => {
    if (loading()) {
      return undefined;
    }
    const loaded = map();
    return loaded.ok ? undefined : loaded.error;
  });
  const sectionHasRows = () => knownRows().length + unknownRows().length > 0;
  const knownKeys = () => scan().known.map((mention) => mention.key);
  const unknownKeys = () => scan().unknown.map((mention) => mention.key);
  const knownPicker = () => {
    const loaded = map();
    openPicker(
      props.ctx,
      "Zinn | keys in this chat",
      knownKeys(),
      loaded.ok ? loaded.value : undefined,
      false,
      mentionCountsByKey(),
      props.sessionID,
    );
  };
  const unknownPicker = () => {
    const loaded = map();
    openPicker(
      props.ctx,
      "Zinn | unknown keys in this chat",
      unknownKeys(),
      loaded.ok ? loaded.value : undefined,
      true,
      mentionCountsByKey(),
      props.sessionID,
    );
  };

  return (
    <box flexDirection="column">
      <RailLine ctx={props.ctx} glyph="┏" onMouseDown={reload}>
        <text fg={theme().text}>
          <b>ZINN</b>
        </text>
        <text fg={theme().textMuted}>[{headerDetail()}]</text>
      </RailLine>

      <Show when={failure()}>
        <RailLine ctx={props.ctx} glyph={sectionHasRows() ? "│" : "┗"}>
          <text wrapMode="none" flexShrink={1} fg={theme().error}>
            {truncate(failure() ?? "", 40)}
          </text>
        </RailLine>
      </Show>

      <Show when={!loading() && map().ok && !sectionHasRows()}>
        <RailLine ctx={props.ctx} glyph="┗">
          <text fg={theme().textMuted}>no task keys in this chat</text>
        </RailLine>
      </Show>

      <For each={visibleKnown()}>
        {(row, index) => (
          <>
            <Show when={props.options.rows === 2 && index() > 0}>
              <RailLine ctx={props.ctx} glyph="│">
                <box
                  flexGrow={1}
                  height={1}
                  borderStyle="single"
                  border={["top"]}
                  borderColor={theme().borderSubtle}
                />
              </RailLine>
            </Show>
            <Row
              ctx={props.ctx}
              row={row}
              titleColumns={titleColumns()}
              metaColumns={metaColumns}
              dense={props.options.rows === 2}
              current={props.options.current}
              markGlyph={
                props.options.current === "glyph" && row.mine && running()
                  ? RUNNING_FRAMES[frame() % RUNNING_FRAMES.length]
                  : undefined
              }
              onOpen={() => open(row.key, row.unknown)}
            />
          </>
        )}
      </For>

      <Show when={knownOverflow() > 0}>
        <Overflow ctx={props.ctx} count={knownOverflow()} label="more" onOpen={knownPicker} />
      </Show>

      <Show when={createdKeys().size > 0}>
        <RailLine ctx={props.ctx} glyph="│">
          <text fg={theme().info}>{`+ created this session (${createdKeys().size})`}</text>
        </RailLine>
      </Show>

      <Show when={unknownRows().length > 0}>
        <RailLine ctx={props.ctx} glyph="│">
          <text fg={theme().warning}>unknown keys (not in store)</text>
        </RailLine>
        <For each={visibleUnknown()}>
          {(row) => (
            <Row
              ctx={props.ctx}
              row={row}
              titleColumns={titleColumns()}
              metaColumns={metaColumns}
              dense={props.options.rows === 2 && !row.unknown}
              current={props.options.current}
              onOpen={() => open(row.key, row.unknown)}
            />
          )}
        </For>
        <Show when={unknownOverflow() > 0}>
          <Overflow
            ctx={props.ctx}
            count={unknownOverflow()}
            label="more unknown"
            onOpen={unknownPicker}
          />
        </Show>
      </Show>

      <Show when={!loading() && map().ok && sectionHasRows()}>
        <RailLine ctx={props.ctx} glyph="┗">
          <text fg={theme().textMuted}>recent mentions</text>
        </RailLine>
      </Show>
    </box>
  );
}
