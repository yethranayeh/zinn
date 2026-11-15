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
  /** 1-based position in the capture, kept when a slot is reused. */
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

export type TabTracePhase = "ready" | "recording" | "stopped";

export type TabTraceState = {
  phase: TabTracePhase;
  captures: number;
};

export type TabTraceOptions = {
  /** The control immediately before the stage in tab order. */
  startControl: HTMLElement;
  /** Called whenever the phase or capture count changes. */
  onChange?: (state: TabTraceState) => void;
};

export type TabTraceHandle = {
  readonly tracing: boolean;
  readonly captures: number;
  /** Starts a new recording, replacing any plates. Moves focus to `startControl`. */
  record(): void;
  /** Ends recording, replays the plates and keeps them. */
  stop(): void;
  /** Ends any recording and removes all plates; the panel stays open. */
  clear(): void;
  /** Ends any recording and removes everything; the caller hides the panel. */
  close(): void;
};

/**
 * Opens the Tab trace mode and returns its capture handle. The caller shows the
 * panel; this module records the real focus stops, redraws the plates and owns
 * the readout.
 *
 * Recording mounts the capture surface before the first stop. The start control
 * sits immediately before the stage in the DOM, so focusing it makes the next
 * Tab the stage's first focus stop. Nothing inside the stage is focused here.
 */
export function openTabTrace(
  stage: HTMLElement,
  content: HTMLElement,
  readout: HTMLElement,
  row: HTMLElement,
  options: TabTraceOptions,
): TabTraceHandle {
  const tones = {
    limestone: token(stage, "--color-limestone"),
    soot: token(stage, "--tone-soot"),
    cinnabar: token(stage, "--tone-cinnabar"),
  };

  const stopNumbers: number[] = [];
  const plates: Plate[] = [];
  let session: CaptureSession | null = null;
  let phase: TabTracePhase = "ready";
  let tracing = false;
  let closed = false;

  const summary = () => `Tab trace · ${stopNumbers.length} captured`;

  const emit = () => {
    options.onChange?.({ phase, captures: stopNumbers.length });
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

  const removePlate = (plate: Plate) => {
    plate.element.remove();
    const index = plates.indexOf(plate);
    if (index !== -1) {
      plates.splice(index, 1);
    }
  };

  const removePlates = () => {
    for (const plate of [...plates]) {
      removePlate(plate);
    }
    stopNumbers.length = 0;
  };

  const renderTray = () => {
    const usableWidth = row.clientWidth || window.innerWidth - 2 * TRAY_INSET;
    const capacity = slotCapacity(usableWidth);
    const kept = new Set(slotStops(stopNumbers, capacity));

    for (const plate of [...plates]) {
      if (!kept.has(plate.stop)) {
        removePlate(plate);
      }
    }

    for (const plate of [...plates].sort((a, b) => a.stop - b.stop)) {
      row.append(plate.element);
    }
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
    emit();
  };

  const replay = () => {
    const replayed = [...plates];
    if (replayed.length === 0) {
      return;
    }

    for (const plate of replayed) {
      plate.element.style.visibility = "hidden";
    }

    const run = stepper();
    run(replayed.length, (frame) => {
      replayed.forEach((plate, index) => {
        plate.element.style.visibility = index <= frame ? "" : "hidden";
      });
    });
  };

  const onFocus = (event: FocusEvent) => {
    const target = event.target;
    if (!tracing || closed || !(target instanceof HTMLElement) || !stage.contains(target)) {
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
        if (!tracing || closed || document.activeElement !== target) {
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
        readout.textContent = `Tab trace · ${number} captured · ${name}`;
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
    session = null;
  };

  const record = () => {
    if (closed || tracing) {
      return;
    }

    // A new recording replaces the previous plates.
    removePlates();
    // The start control sits before the stage, so the next Tab is its first stop.
    options.startControl.focus();
    tracing = true;
    phase = "recording";
    session = startSession(stage, { content });
    stage.addEventListener("focusin", onFocus);
    readout.textContent = "Tab trace · recording";
    emit();
  };

  const stop = () => {
    if (!tracing) {
      return;
    }

    stopCapture();

    if (stopNumbers.length === 0) {
      phase = "ready";
      readout.textContent = "Tab trace · ready";
    } else {
      phase = "stopped";
      readout.textContent = summary();
      replay();
    }

    emit();
  };

  const clear = () => {
    if (closed) {
      return;
    }

    stopCapture();
    removePlates();
    phase = "ready";
    readout.textContent = "Tab trace · ready";
    emit();
  };

  const onResize = () => {
    if (tracing) {
      stopCapture();

      if (stopNumbers.length === 0) {
        phase = "ready";
        readout.textContent = "Tab trace · ready";
      } else {
        phase = "stopped";
        readout.textContent = summary();
      }

      emit();
    }

    // Refit the held plates to the panel's new width.
    renderTray();
  };

  const close = () => {
    if (closed) {
      return;
    }

    closed = true;
    stopCapture();
    window.removeEventListener("resize", onResize);
    stage.removeAttribute("data-trace-active");
    removePlates();
    readout.style.whiteSpace = readoutLine.whiteSpace;
    readout.style.overflow = readoutLine.overflow;
    readout.style.textOverflow = readoutLine.textOverflow;
    readout.style.minWidth = readoutLine.minWidth;
  };

  stage.setAttribute("data-trace-active", "");
  window.addEventListener("resize", onResize, { passive: true });
  readout.textContent = "Tab trace · ready";
  emit();

  return {
    get tracing() {
      return tracing;
    },
    get captures() {
      return stopNumbers.length;
    },
    record,
    stop,
    clear,
    close,
  };
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function token(element: HTMLElement, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}
