import type { Rect } from "./measure";
import type { CaptureSession, DrawableSnapshot } from "../canvas/drawable";

import { fit, stepper } from "../../src/components/ui/texture-slider/canvas";
import { startSession } from "../canvas/drawable";
import {
  PLATE_CAPTION_HEIGHT,
  PLATE_IMAGE_HEIGHT,
  PLATE_WIDTH,
  RING_ROOM,
  cropFor,
  fitCrop,
  rectInPlate,
  slotCapacity,
  slotStops,
} from "./plates";

const PLATE_BORDER = 1;
/** The tray's border and padding, used when its row cannot be measured. */
const TRAY_INSET = 11;

type PlateData = {
  /** 1-based position in the trace, kept when a slot is reused. */
  stop: number;
  name: string;
  crop: Rect;
  focus: Rect;
  tooltip: Rect | null;
};

type Plate = PlateData & {
  element: HTMLElement;
  canvas: HTMLCanvasElement;
};

export type TabTraceOptions = {
  /** Clears the whole trace, including the tray. */
  onClear?: () => void;
};

export type TabTraceHandle = {
  /** True while real focus stops are being captured. */
  readonly tracing: boolean;
  /** Ends capture, restores the DOM and replays the plates. */
  end(): void;
  /** Removes the tray and restores everything. */
  clear(): void;
};

/**
 * Records the real keyboard focus stops inside the stage as numbered plates in a
 * fixed tray. The capture surface is mounted before the first stop, so mounting
 * cannot blur a stop. Every plate is read from one `focusin`; nothing is
 * synthesised and the tray is never captured.
 */
export function startTabTrace(
  stage: HTMLElement,
  content: HTMLElement,
  readout: HTMLElement,
  options: TabTraceOptions = {},
): TabTraceHandle {
  const session: CaptureSession | null = startSession(stage, { content });
  const tones = {
    limestone: token(stage, "--color-limestone"),
    soot: token(stage, "--tone-soot"),
    cinnabar: token(stage, "--tone-cinnabar"),
  };

  const tray = document.createElement("div");
  tray.className = "ov-trace";
  tray.setAttribute("role", "region");
  tray.setAttribute("aria-label", "Tab trace");

  const head = document.createElement("div");
  head.className = "ov-trace-head";

  const title = document.createElement("span");
  title.className = "ov-trace-title";
  title.textContent = "Tab trace";

  const status = document.createElement("span");
  status.className = "ov-trace-status";

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "ov-trace-clear";
  clearButton.textContent = "Clear";
  clearButton.setAttribute("aria-label", "Clear tab trace");

  head.append(title, status, clearButton);

  const row = document.createElement("div");
  row.className = "ov-trace-row";
  row.setAttribute("aria-hidden", "true");

  tray.append(head, row);
  document.body.append(tray);
  stage.setAttribute("data-trace-active", "");

  const stopNumbers: number[] = [];
  const plates: Plate[] = [];
  let tracing = true;
  let cleared = false;

  const setStatus = () => {
    const count = stopNumbers.length;
    status.textContent =
      count === 0 ? "Tab through the stage" : `${count} ${count === 1 ? "stop" : "stops"}`;
  };

  // One line keeps the readout from adding a toolbar row, which would move the stage.
  const readoutLine = {
    whiteSpace: readout.style.whiteSpace,
    overflow: readout.style.overflow,
    textOverflow: readout.style.textOverflow,
    minWidth: readout.style.minWidth,
  };
  readout.style.whiteSpace = "nowrap";
  readout.style.overflow = "hidden";
  readout.style.textOverflow = "ellipsis";
  readout.style.minWidth = "0";

  const surfaceSize = () => {
    const rect = stage.getBoundingClientRect();
    const styles = getComputedStyle(stage);
    return {
      w: rect.width - px(styles.borderLeftWidth) - px(styles.borderRightWidth),
      h: rect.height - px(styles.borderTopWidth) - px(styles.borderBottomWidth),
    };
  };

  const surfaceOrigin = () => {
    const rect = stage.getBoundingClientRect();
    const styles = getComputedStyle(stage);
    return {
      x: rect.left + px(styles.borderLeftWidth),
      y: rect.top + px(styles.borderTopWidth),
    };
  };

  const rectInSurface = (element: Element, origin: { x: number; y: number }): Rect => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left - origin.x, y: rect.top - origin.y, w: rect.width, h: rect.height };
  };

  const renderTray = () => {
    const usableWidth = row.clientWidth || window.innerWidth - 2 * TRAY_INSET;
    const capacity = slotCapacity(usableWidth);
    const kept = new Set(slotStops(stopNumbers, capacity));

    for (const plate of [...plates]) {
      if (kept.has(plate.stop)) {
        continue;
      }
      plate.element.remove();
      plates.splice(plates.indexOf(plate), 1);
    }

    for (const plate of [...plates].sort((a, b) => a.stop - b.stop)) {
      row.append(plate.element);
    }

    setStatus();
  };

  const drawPlate = (
    canvas: HTMLCanvasElement,
    data: PlateData,
    snapshot: DrawableSnapshot | null,
  ) => {
    const { context, width, height } = fit(canvas);
    context.clearRect(0, 0, width, height);
    context.fillStyle = tones.limestone;
    context.fillRect(0, 0, width, height);

    const placement = fitCrop(data.crop, { x: 0, y: 0, w: width, h: height });

    if (snapshot) {
      context.drawImage(
        snapshot.image,
        0,
        0,
        snapshot.image.width,
        snapshot.image.height,
        placement.x,
        placement.y,
        placement.w,
        placement.h,
      );
      return;
    }

    // No pixels: the same boxes, from geometry only.
    const focus = rectInPlate(data.focus, data.crop, placement);
    context.strokeStyle = tones.soot;
    context.lineWidth = 1.5;
    context.strokeRect(focus.x, focus.y, Math.max(focus.w, 1), Math.max(focus.h, 1));

    if (data.tooltip) {
      const tooltip = rectInPlate(data.tooltip, data.crop, placement);
      context.strokeStyle = tones.cinnabar;
      context.lineWidth = 1;
      context.setLineDash([4, 3]);
      context.strokeRect(tooltip.x, tooltip.y, Math.max(tooltip.w, 1), Math.max(tooltip.h, 1));
      context.setLineDash([]);
    }
  };

  const addPlate = (data: PlateData, snapshot: DrawableSnapshot | null) => {
    const element = document.createElement("div");
    element.className = "ov-plate";
    element.dataset.stop = String(data.stop);
    element.style.width = `${PLATE_WIDTH}px`;
    element.style.borderWidth = `${PLATE_BORDER}px`;

    const canvas = document.createElement("canvas");
    canvas.className = "ov-plate-image";
    canvas.style.height = `${PLATE_IMAGE_HEIGHT}px`;
    canvas.setAttribute("aria-hidden", "true");

    const caption = document.createElement("p");
    caption.className = "ov-plate-caption";
    caption.style.height = `${PLATE_CAPTION_HEIGHT}px`;
    const number = document.createElement("b");
    number.textContent = String(data.stop);
    const name = document.createElement("span");
    name.textContent = data.name;
    caption.append(number, name);

    element.append(canvas, caption);
    plates.push({ ...data, element, canvas });
    renderTray();
    // The canvas needs its CSS box before it can be sized to device pixels.
    drawPlate(canvas, data, snapshot);
  };

  const replay = () => {
    if (plates.length === 0) {
      return;
    }

    for (const plate of plates) {
      plate.element.style.visibility = "hidden";
    }

    const run = stepper();
    run(plates.length, (frame) => {
      plates.forEach((plate, index) => {
        plate.element.style.visibility = index <= frame ? "" : "hidden";
      });
    });
  };

  const stopCapture = () => {
    if (!tracing) {
      return;
    }

    tracing = false;
    stage.removeEventListener("focusin", onFocus);
    session?.restore();
  };

  const summary = () => `Tab trace · ${stopNumbers.length} stops`;

  const end = () => {
    if (!tracing) {
      return;
    }

    stopCapture();
    readout.textContent = summary();
    setStatus();
    replay();
  };

  const onFocus = (event: FocusEvent) => {
    const target = event.target;
    if (!tracing || cleared || !(target instanceof HTMLElement) || !stage.contains(target)) {
      return;
    }

    const root = target.closest<HTMLElement>("[data-inspect]");
    if (!root || !stage.contains(root)) {
      return;
    }

    const number = stopNumbers.length + 1;
    // Wait for the frame that carries the focus ring and any opened tooltip.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        // A stop the browser already moved past cannot be shown honestly.
        if (!tracing || cleared || document.activeElement !== target) {
          return;
        }

        const origin = surfaceOrigin();
        const focus = rectInSurface(target, origin);
        const tooltipElement = root.querySelector<HTMLElement>('[role="tooltip"]');
        const tooltip =
          tooltipElement && tooltipElement.getClientRects().length > 0
            ? rectInSurface(tooltipElement, origin)
            : null;
        const name = root.dataset.inspect?.trim() || target.tagName.toLowerCase();
        const crop = cropFor(focus, tooltip, surfaceSize(), RING_ROOM);
        const snapshot = session?.read({ box: crop, scale: 1 }) ?? null;

        stopNumbers.push(number);
        addPlate({ stop: number, name, crop, focus, tooltip }, snapshot);
        readout.textContent = `Tab trace · stop ${number} · ${name}`;
      });
    });
  };

  const onResize = () => {
    stopCapture();
    setStatus();
    readout.textContent = summary();
  };

  const clear = () => {
    if (cleared) {
      return;
    }

    cleared = true;
    stopCapture();
    window.removeEventListener("resize", onResize);
    tray.remove();
    stage.removeAttribute("data-trace-active");
    plates.length = 0;
    stopNumbers.length = 0;
    readout.style.whiteSpace = readoutLine.whiteSpace;
    readout.style.overflow = readoutLine.overflow;
    readout.style.textOverflow = readoutLine.textOverflow;
    readout.style.minWidth = readoutLine.minWidth;
  };

  clearButton.addEventListener("click", () => {
    if (options.onClear) {
      options.onClear();
      return;
    }
    clear();
  });

  stage.addEventListener("focusin", onFocus);
  window.addEventListener("resize", onResize, { passive: true });
  readout.textContent = "Tab trace · tab through the stage";
  setStatus();

  return {
    get tracing() {
      return tracing;
    },
    end,
    clear,
  };
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function token(element: HTMLElement, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}
