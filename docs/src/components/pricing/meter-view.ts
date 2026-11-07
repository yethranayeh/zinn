import type { HistoryKey, Kind, RequestRecord, Snapshot } from "./meter-data";

import { sizeLabel } from "../../config/pricing-labels";
import { drawStrip } from "./meter-draw";
import { createMonitor } from "./meter-data";
import { clsLabel, lcpLabel, msLabel, values } from "./meter-format";

/** Rows that fit the module at three columns without crowding the meter */
const waterfallRows = 8;
/** Keeps a very short request visible in its track */
const minimumBarShare = 0.6;

const barColors: Record<Kind, string> = {
  document: "bg-soot",
  scripts: "bg-soot/[0.72]",
  styles: "bg-soot/[0.55]",
  fonts: "bg-soot/[0.4]",
  images: "bg-soot/[0.62]",
  other: "bg-soot/[0.3]",
};

function setText(element: HTMLElement | null, text: string) {
  if (element) {
    element.textContent = text;
  }
}

function waterfallRow(entry: RequestRecord, end: number) {
  const item = document.createElement("li");
  item.className =
    "grid grid-cols-[minmax(0,13rem)_3.6rem_minmax(0,1fr)_3.6rem] items-center gap-2.5 border-b border-soot/[0.12] py-1 text-[10.5px]/[1.3] @max-[640px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]";
  item.dataset.row = "";

  const name = document.createElement("span");
  name.className = "truncate";
  name.textContent = entry.label;
  name.title = entry.name;

  const kind = document.createElement("span");
  kind.className =
    "text-[9px] tracking-[0.1em] text-muted-foreground uppercase @max-[640px]:hidden";
  kind.textContent = entry.kind;

  const track = document.createElement("span");
  track.className = "relative h-[9px] bg-soot/[0.08]";
  const bar = document.createElement("i");
  bar.className = `absolute inset-y-0 left-0 ${barColors[entry.kind]}`;
  bar.style.left = `${Math.min(100, (entry.start / end) * 100)}%`;
  bar.style.width = `${Math.max(minimumBarShare, Math.min(100, (entry.duration / end) * 100))}%`;
  track.append(bar);

  const bytes = document.createElement("span");
  bytes.className = "text-right whitespace-nowrap";
  bytes.setAttribute("data-size", "");
  bytes.textContent = sizeLabel(entry.transfer);

  item.append(name, kind, track, bytes);
  return item;
}

function setupWaterfall(root: HTMLElement) {
  const list = root.querySelector<HTMLOListElement>("[data-rows]");
  const more = root.querySelector<HTMLElement>("[data-more]");
  const end = root.querySelector<HTMLElement>("[data-trace-end]");
  let signature = "";

  return (snapshot: Snapshot) => {
    if (end) {
      end.textContent = `${Math.round(snapshot.timelineEnd)} ms`;
    }
    if (!list) {
      return;
    }

    const next = `${snapshot.timeline.length}:${Math.round(snapshot.timelineEnd)}`;
    if (next === signature) {
      return;
    }
    signature = next;

    const shown = snapshot.timeline.slice(0, waterfallRows);
    list.replaceChildren(...shown.map((entry) => waterfallRow(entry, snapshot.timelineEnd)));

    if (more) {
      const remaining = snapshot.timeline.length - shown.length;
      more.hidden = remaining <= 0;
      more.textContent = `${remaining} more requests, counted in the total.`;
    }
  };
}

function layoutPaint(root: HTMLElement, snapshot: Snapshot) {
  const module = root.querySelector<HTMLElement>("[data-paint]");
  if (!module) {
    return;
  }

  const blocked = snapshot.blockedState !== "unsupported";
  const lcp = snapshot.lcpState !== "unsupported";
  const cls = snapshot.clsState !== "unsupported";

  if (!blocked && !lcp && !cls) {
    module.remove();
    return;
  }

  const label = module.querySelector<HTMLElement>("[data-module-label]");
  const meta = module.querySelector<HTMLElement>("[data-module-meta]");
  const big = module.querySelector<HTMLElement>("[data-paint-big]");
  const sub = module.querySelector<HTMLElement>("[data-sub]");
  const lcpOption = module.querySelector<HTMLElement>("[data-paint-option='lcp']");
  const clsOption = module.querySelector<HTMLElement>("[data-paint-option='cls']");
  const separator = module.querySelector<HTMLElement>("[data-paint-separator]");

  if (blocked) {
    setText(label, "Main thread");
    setText(meta, "blocked");
    setText(big, msLabel(snapshot.blockedMs ?? 0));
    if (lcpOption) {
      lcpOption.hidden = !lcp;
    }
    if (clsOption) {
      clsOption.hidden = !cls;
    }
    if (separator) {
      separator.hidden = !(lcp && cls);
    }
    if (sub) {
      sub.hidden = !(lcp || cls);
    }
    return;
  }

  setText(label, "Paint");
  setText(meta, lcp ? "largest paint" : "layout shift");
  setText(big, lcp ? lcpLabel(snapshot) : clsLabel(snapshot));
  if (lcpOption) {
    lcpOption.hidden = true;
  }
  if (clsOption) {
    clsOption.hidden = !(lcp && cls);
  }
  if (separator) {
    separator.hidden = true;
  }
  if (sub) {
    sub.hidden = !(lcp && cls);
  }
}

function layoutMemory(root: HTMLElement, snapshot: Snapshot) {
  const module = root.querySelector<HTMLElement>("[data-memory]");
  if (!module) {
    return;
  }

  if (snapshot.heapUsed === null) {
    module.remove();
    return;
  }

  const sub = module.querySelector<HTMLElement>("[data-sub]");
  const cpu = module.querySelector<HTMLElement>("[data-option='cpu']");
  const connection = module.querySelector<HTMLElement>("[data-option='connection']");
  const separator = module.querySelector<HTMLElement>("[data-separator]");

  if (cpu) {
    cpu.hidden = snapshot.cpuState !== "ok";
  }
  if (connection) {
    connection.hidden = snapshot.connection === null;
  }

  const cpuShown = cpu !== null && !cpu.hidden;
  const connectionShown = connection !== null && !connection.hidden;
  if (separator) {
    separator.hidden = !(cpuShown && connectionShown);
  }
  if (sub) {
    sub.hidden = !cpuShown && !connectionShown;
  }
}

function updateChip(total: string, time: string) {
  const bytes = document.querySelector<HTMLElement>("[data-chip-bytes]");
  const timeOut = document.querySelector<HTMLElement>("[data-chip-time]");
  if (bytes) {
    bytes.textContent = total;
  }
  if (timeOut) {
    timeOut.textContent = time;
  }
}

export function mountMonitor(root: HTMLElement) {
  const monitor = createMonitor();
  const strips: Array<[HTMLCanvasElement | null, HistoryKey]> = [
    [root.querySelector<HTMLCanvasElement>("[data-strip='bytes']"), "bytes"],
    [root.querySelector<HTMLCanvasElement>("[data-strip='canvas']"), "canvas"],
    [root.querySelector<HTMLCanvasElement>("[data-strip='heap']"), "heap"],
  ];
  const shares = [...root.querySelectorAll<HTMLElement>("[data-share]")];
  const updateWaterfall = setupWaterfall(root);

  function apply() {
    const snapshot = monitor.snapshot();
    const map = values(snapshot);

    for (const element of root.querySelectorAll<HTMLElement>("[data-f]")) {
      const text = map[element.dataset.f ?? ""];
      if (text !== undefined) {
        element.textContent = text;
      }
    }

    layoutPaint(root, snapshot);
    layoutMemory(root, snapshot);
    updateWaterfall(snapshot);

    const total = Math.max(1, snapshot.total);
    for (const bar of shares) {
      const kind = bar.dataset.share as Kind;
      bar.style.width = `${Math.min(100, (snapshot.kinds[kind] / total) * 100)}%`;
    }

    for (const [canvas, key] of strips) {
      if (canvas) {
        drawStrip(canvas, snapshot.history[key]);
      }
    }

    updateChip(map.total, map.open);
  }

  apply();
  const timer = window.setInterval(apply, 1000);

  return () => {
    window.clearInterval(timer);
    monitor.destroy();
  };
}
