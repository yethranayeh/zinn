import { framesDrawn } from "./canvas";

const HISTORY_LENGTH = 60;

export type Kind = "document" | "scripts" | "styles" | "fonts" | "images" | "other";

export type OptionalState = "ok" | "pending" | "unsupported";

export type HistoryKey = "bytes" | "canvas" | "heap";

export interface RequestRecord {
  name: string;
  label: string;
  kind: Kind;
  start: number;
  duration: number;
  transfer: number;
}

export interface Snapshot {
  total: number;
  kinds: Record<Kind, number>;
  requests: number;
  decoded: number;
  cached: number;
  openMs: number;
  visibleMs: number;
  frames: number;
  elements: number;
  canvases: number;
  blockedMs: number | null;
  blockedState: OptionalState;
  lcpMs: number | null;
  lcpState: OptionalState;
  cls: number | null;
  clsState: OptionalState;
  heapUsed: number | null;
  cpu: string | null;
  cpuState: OptionalState;
  connection: string | null;
  history: Record<HistoryKey, number[]>;
  timeline: RequestRecord[];
  timelineEnd: number;
}

const extensionKinds: Record<string, Kind> = {
  js: "scripts",
  mjs: "scripts",
  cjs: "scripts",
  ts: "scripts",
  tsx: "scripts",
  jsx: "scripts",
  css: "styles",
  woff: "fonts",
  woff2: "fonts",
  ttf: "fonts",
  otf: "fonts",
  eot: "fonts",
  png: "images",
  jpg: "images",
  jpeg: "images",
  gif: "images",
  webp: "images",
  avif: "images",
  svg: "images",
  ico: "images",
};

function kindOf(name: string, navigation: boolean): Kind {
  if (navigation) {
    return "document";
  }

  const clean = name.split(/[?#]/)[0];
  const file = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  const extension = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";

  return extensionKinds[extension] ?? "other";
}

function labelOf(name: string) {
  try {
    const path = new URL(name, location.href).pathname;
    const parts = path.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponent(last) : path;
  } catch {
    return name;
  }
}

const started = performance.now();
let visibleTotal = 0;
let visibleSince = document.visibilityState === "visible" ? started : 0;

document.addEventListener("visibilitychange", () => {
  const now = performance.now();
  if (document.visibilityState === "visible") {
    visibleSince = now;
  } else if (visibleSince !== 0) {
    visibleTotal += now - visibleSince;
    visibleSince = 0;
  }
});

function pageTiming() {
  const now = performance.now();
  return {
    openMs: now - started,
    visibleMs: visibleTotal + (visibleSince !== 0 ? now - visibleSince : 0),
  };
}

export function createMonitor() {
  const disposers: Array<() => void> = [];
  const totals: Record<Kind, number> = {
    document: 0,
    scripts: 0,
    styles: 0,
    fonts: 0,
    images: 0,
    other: 0,
  };
  const seen = new Set<string>();
  const records: RequestRecord[] = [];
  const history: Record<HistoryKey, number[]> = { bytes: [], canvas: [], heap: [] };
  let total = 0;
  let requestCount = 0;
  let decoded = 0;
  let cached = 0;
  let timelineEnd = 1000;

  let blockedMs = 0;
  let blockedState: OptionalState = "unsupported";
  let lcpMs: number | null = null;
  let lcpState: OptionalState = "unsupported";
  let cls: number | null = 0;
  let clsState: OptionalState = "unsupported";
  let cpu: string | null = null;
  let cpuState: OptionalState = "unsupported";

  function ingest(entries: ReadonlyArray<PerformanceEntry>) {
    for (const entry of entries as PerformanceResourceTiming[]) {
      if (typeof entry.startTime !== "number" || typeof entry.name !== "string") {
        continue;
      }

      const key = `${entry.name}@${entry.startTime}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const navigation = entry.entryType === "navigation";
      const kind = kindOf(entry.name, navigation);
      // transferSize is 0 for cached responses, so those count by their encoded size.
      const transfer = entry.transferSize || entry.encodedBodySize || 0;
      const unpacked = entry.decodedBodySize || 0;
      const fromCache = entry.transferSize < entry.encodedBodySize;

      total += transfer;
      totals[kind] += transfer;
      requestCount += 1;
      decoded += unpacked;
      if (fromCache) {
        cached += entry.encodedBodySize || 0;
      }
      timelineEnd = Math.max(timelineEnd, entry.startTime + entry.duration);
      if (navigation) {
        timelineEnd = Math.max(
          timelineEnd,
          (entry as PerformanceNavigationTiming).loadEventEnd || 0,
        );
      }

      records.push({
        name: entry.name,
        label: labelOf(entry.name),
        kind,
        start: entry.startTime,
        duration: entry.duration,
        transfer,
      });
    }
  }

  ingest(performance.getEntriesByType("navigation"));
  ingest(performance.getEntriesByType("resource"));

  const resourceObserver = new PerformanceObserver((list) => ingest(list.getEntries()));
  resourceObserver.observe({ type: "resource", buffered: true });
  disposers.push(() => resourceObserver.disconnect());

  const entryTypes = PerformanceObserver.supportedEntryTypes ?? [];

  if (entryTypes.includes("long-animation-frame")) {
    blockedState = "ok";
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & { blockingDuration?: number }
      >) {
        blockedMs += entry.blockingDuration ?? 0;
      }
    });
    observer.observe({ type: "long-animation-frame" });
    disposers.push(() => observer.disconnect());
  } else if (entryTypes.includes("longtask")) {
    blockedState = "ok";
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        blockedMs += entry.duration;
      }
    });
    observer.observe({ type: "longtask", buffered: true });
    disposers.push(() => observer.disconnect());
  }

  if (entryTypes.includes("largest-contentful-paint")) {
    lcpState = "pending";
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) {
        lcpMs = last.startTime;
        lcpState = "ok";
      }
    });
    observer.observe({ type: "largest-contentful-paint", buffered: true });
    disposers.push(() => observer.disconnect());
  }

  if (entryTypes.includes("layout-shift")) {
    clsState = "ok";
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & { value?: number; hadRecentInput?: boolean }
      >) {
        if (!entry.hadRecentInput) {
          cls = (cls ?? 0) + (entry.value ?? 0);
        }
      }
    });
    observer.observe({ type: "layout-shift", buffered: true });
    disposers.push(() => observer.disconnect());
  }

  const Pressure = (
    window as unknown as {
      PressureObserver?: new (callback: (entries: Array<{ state?: string }>) => void) => {
        observe: (source: string, options?: { sampleInterval?: number }) => Promise<void>;
        disconnect: () => void;
      };
    }
  ).PressureObserver;

  if (typeof Pressure === "function") {
    try {
      const pressure = new Pressure((entries) => {
        const last = entries[entries.length - 1];
        if (last?.state) {
          cpu = last.state;
          cpuState = "ok";
        }
      });
      const observing = pressure.observe("cpu", { sampleInterval: 1000 });
      observing?.catch(() => {
        cpuState = "unsupported";
      });
      disposers.push(() => pressure.disconnect());
    } catch {
      cpuState = "unsupported";
    }
  }

  function push(key: HistoryKey, value: number) {
    history[key].push(value);
    if (history[key].length > HISTORY_LENGTH) {
      history[key].shift();
    }
  }

  function snapshot(): Snapshot {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    const heapUsed = typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;

    const connection = (
      navigator as unknown as {
        connection?: { effectiveType?: string; rtt?: number };
      }
    ).connection;
    const effectiveType = connection?.effectiveType;
    const rtt = connection?.rtt;
    const connectionLabel = effectiveType
      ? `${effectiveType}${typeof rtt === "number" ? ` · ${Math.round(rtt)} ms RTT` : ""}`
      : null;

    const { openMs, visibleMs } = pageTiming();
    const frames = framesDrawn();
    const elements = document.getElementsByTagName("*").length;
    const canvases = document.querySelectorAll("canvas").length;

    push("bytes", total);
    push("canvas", frames);
    push("heap", heapUsed ?? 0);

    const sorted = [...records].sort((a, b) => a.start - b.start);

    return {
      total,
      kinds: { ...totals },
      requests: requestCount,
      decoded,
      cached,
      openMs,
      visibleMs,
      frames,
      elements,
      canvases,
      blockedMs: blockedState === "ok" ? blockedMs : null,
      blockedState,
      lcpMs,
      lcpState,
      cls,
      clsState,
      heapUsed,
      cpu,
      cpuState,
      connection: connectionLabel,
      history,
      timeline: sorted,
      timelineEnd,
    };
  }

  return {
    snapshot,
    destroy() {
      for (const dispose of disposers) {
        dispose();
      }
    },
  };
}
