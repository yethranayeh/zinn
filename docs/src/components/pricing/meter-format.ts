import type { Snapshot } from "./meter-data";

import { groupedNumber, memoryLabel, sizeLabel } from "../../config/pricing-labels";

export function clock(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

export function msLabel(value: number) {
  if (value === 0) {
    return "0 ms";
  }

  if (value < 10) {
    return `${value.toFixed(1)} ms`;
  }

  return `${Math.round(value)} ms`;
}

export function lcpLabel(snapshot: Snapshot) {
  return snapshot.lcpMs === null ? "reading" : `${Math.round(snapshot.lcpMs)} ms`;
}

export function clsLabel(snapshot: Snapshot) {
  return (snapshot.cls ?? 0).toFixed(3);
}

export function values(snapshot: Snapshot): Record<string, string> {
  const kindSum = Object.values(snapshot.kinds).reduce((sum, bytes) => sum + bytes, 0);
  const map: Record<string, string> = {
    total: sizeLabel(snapshot.total),
    cached: sizeLabel(snapshot.cached),
    decoded: sizeLabel(snapshot.decoded),
    requests: groupedNumber(snapshot.requests),
    "kind-document": sizeLabel(snapshot.kinds.document),
    "kind-scripts": sizeLabel(snapshot.kinds.scripts),
    "kind-styles": sizeLabel(snapshot.kinds.styles),
    "kind-fonts": sizeLabel(snapshot.kinds.fonts),
    "kind-images": sizeLabel(snapshot.kinds.images),
    "kind-other": sizeLabel(snapshot.kinds.other),
    "kind-sum": sizeLabel(kindSum),
    open: clock(snapshot.openMs),
    visible: clock(snapshot.visibleMs),
    canvas: groupedNumber(snapshot.frames),
    elements: groupedNumber(snapshot.elements),
    canvases: groupedNumber(snapshot.canvases),
  };

  if (snapshot.blockedMs !== null) {
    map.blocked = msLabel(snapshot.blockedMs);
  }
  if (snapshot.lcpState !== "unsupported") {
    map.lcp = lcpLabel(snapshot);
  }
  if (snapshot.clsState !== "unsupported") {
    map.cls = clsLabel(snapshot);
  }
  if (snapshot.heapUsed !== null) {
    map.heap = memoryLabel(snapshot.heapUsed);
  }
  if (snapshot.cpuState === "ok" && snapshot.cpu) {
    map.cpu = snapshot.cpu;
  }
  if (snapshot.connection) {
    map.connection = snapshot.connection;
  }

  return map;
}
