/**
 * Live DOM capture through Chrome's HTML-in-canvas API.
 *
 * A surface is an element whose padding box the capture covers. Its content
 * (`[data-stage-content]` by default) is moved into a
 * `<canvas content="drawable">` positioned over the same box, and a layout
 * wrapper inside the canvas repeats the surface's padding, so the content keeps
 * its exact size and position. The canvas only paints that subtree, so the
 * inspector's own layers stay out of the capture.
 *
 * `drawElementImage` paints only into the canvas that owns the subtree, so a
 * snapshot is a copy read back from that canvas. A missing API, a refused
 * capture, an empty frame or a forced fallback returns `null`. Callers draw
 * their own fallback from geometry.
 *
 * Verification override: `?capture=off` on the page URL, or `forceFallback()`.
 * The live surface renders at `min(devicePixelRatio, 2)`. `capture()` exports
 * at the requested scale. A session read resamples its live surface.
 */

export type Box = { x: number; y: number; w: number; h: number };

export type DrawableSnapshot = {
  /** The captured pixels, at `scale`. Treat as read-only. */
  image: HTMLCanvasElement;
  /** The captured region inside the surface, in CSS px. */
  box: Box;
  /** Image pixels per CSS pixel. */
  scale: number;
  /** The surface's CSS size at capture time. */
  surface: { w: number; h: number };
};

export type CaptureOptions = {
  /** The live subtree to capture. Defaults to the surface's `[data-stage-content]`. */
  content?: HTMLElement;
  /** Output pixels per CSS pixel. Default 1. */
  scale?: number;
  /** Caller state that must change before a cached capture is reused. */
  token?: string;
  /** Captured region inside the surface, in CSS px. Defaults to all of it. */
  box?: Box;
};

export type ReadOptions = {
  box?: Box;
  scale?: number;
};

export type CaptureSession = {
  /** True once the surface is mounted and a probe frame came back with pixels. */
  readonly live: boolean;
  readonly surface: { w: number; h: number };
  /** The current frame, cropped to `box`. Always live, never cached. */
  read(options?: ReadOptions): DrawableSnapshot | null;
  /** Restores the DOM and stops the loop. Safe to call more than once. */
  restore(): void;
};

type DrawableContext = CanvasRenderingContext2D & {
  drawElementImage(element: Element, x: number, y: number, width: number, height: number): void;
};

const CONTENT_SELECTOR = "[data-stage-content]";
const DRAWABLE = "drawable";
const DISABLED_QUERY = "capture";
const DISABLED_VALUE = "off";
/** Enough for a 2x surface to stay sharp and cheap enough for a whole stage. */
const LIVE_DPR_LIMIT = 2;
const PROBE_ATTEMPTS = 3;
/** A prime stride keeps the probe cheap without reading every pixel. */
const PROBE_STRIDE = 97;
const CACHE_LIMIT = 2;

let fallbackForced = false;
let cacheGeneration = 0;
let fontsVersion = 0;
let fontsWatched = false;
let pageHideWatched = false;

const mountedSurfaces = new Set<HTMLElement>();
const activeRestores = new Set<() => void>();
const snapshotCache = new WeakMap<HTMLElement, Array<CacheEntry>>();

type CacheEntry = {
  key: string;
  width: number;
  height: number;
  fonts: number;
  generation: number;
  snapshot: DrawableSnapshot;
};

type MountedSurface = {
  readonly canvas: HTMLCanvasElement;
  readonly root: HTMLElement;
  readonly width: number;
  readonly height: number;
  readonly liveDpr: number;
  /** Draws the live subtree at `scale`, clearing the bitmap first. */
  paint(scale: number): void;
  /** Renders the crop at `scale` into a fresh canvas. */
  render(box: Box, scale: number): HTMLCanvasElement | null;
  restore(): void;
};

/** Whether Chrome can paint a live subtree into this canvas. */
export function supportsDrawElementImage(): boolean {
  if (fallbackForced || disabledByPage()) {
    return false;
  }

  const context = document.createElement("canvas").getContext("2d");
  return context !== null && typeof (context as DrawableContext).drawElementImage === "function";
}

/** Forces the geometry fallback, for verification without editing this module. */
export function forceFallback(forced = true): void {
  fallbackForced = forced;
}

/** Drops cached snapshots; naming an element also drops its entries. */
export function invalidate(element?: HTMLElement): void {
  cacheGeneration += 1;
  if (element) {
    snapshotCache.delete(element);
  }
}

/**
 * Captures the surface once, restores the DOM and returns the snapshot.
 * Returns `null` while a session holds the same surface.
 */
export async function capture(
  element: HTMLElement,
  options: CaptureOptions = {},
): Promise<DrawableSnapshot | null> {
  if (!supportsDrawElementImage() || document.visibilityState === "hidden") {
    return null;
  }

  const content = options.content ?? contentOf(element);
  const size = surfaceSizeOf(element);
  const scale = options.scale ?? 1;
  if (!content || !size || !(scale > 0) || mountedSurfaces.has(element)) {
    return null;
  }

  const box = clampBox(options.box ?? { x: 0, y: 0, w: size.w, h: size.h }, size);
  if (box.w < 1 || box.h < 1) {
    return null;
  }

  const key = cacheKey(options.token ?? "", scale, box);
  const cached = cachedSnapshot(element, key, size);
  if (cached) {
    return cached;
  }

  const mounted = mountSurface(element, content);
  if (!mounted) {
    return null;
  }

  try {
    if (!(await probe(mounted))) {
      return null;
    }

    const image = mounted.render(box, scale);
    if (!image) {
      return null;
    }

    const snapshot: DrawableSnapshot = {
      image,
      box,
      scale,
      surface: { w: mounted.width, h: mounted.height },
    };
    storeSnapshot(element, key, size, snapshot);
    return snapshot;
  } catch {
    return null;
  } finally {
    mounted.restore();
  }
}

/** Mounts the surface once and reads frames from it until `restore()`. */
export function startSession(
  element: HTMLElement,
  options: CaptureOptions = {},
): CaptureSession | null {
  if (!supportsDrawElementImage() || document.visibilityState === "hidden") {
    return null;
  }

  const content = options.content ?? contentOf(element);
  if (!content || mountedSurfaces.has(element)) {
    return null;
  }

  const mounted = mountSurface(element, content);
  if (!mounted) {
    return null;
  }

  const surface = { w: mounted.width, h: mounted.height };
  let live = false;
  let stopped = false;
  let frame = 0;

  const stop = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    live = false;
    window.cancelAnimationFrame(frame);
    window.removeEventListener("pagehide", stop);
    mounted.restore();
  };
  window.addEventListener("pagehide", stop);

  const loop = () => {
    if (stopped) {
      return;
    }

    try {
      mounted.paint(mounted.liveDpr);
    } catch {
      // A refused frame would freeze the page behind an empty canvas.
      stop();
      return;
    }

    frame = window.requestAnimationFrame(loop);
  };

  void probe(mounted).then((painted) => {
    if (!painted || stopped) {
      // Without pixels the surface must not stay mounted: the subtree would freeze.
      stop();
      return;
    }

    live = true;
    frame = window.requestAnimationFrame(loop);
  });

  return {
    get live() {
      return live && !stopped;
    },
    surface,
    read(readOptions: ReadOptions = {}) {
      if (!live || stopped) {
        return null;
      }

      const box = clampBox(readOptions.box ?? { x: 0, y: 0, w: surface.w, h: surface.h }, surface);
      const scale = readOptions.scale ?? 1;
      if (box.w < 1 || box.h < 1 || !(scale > 0)) {
        return null;
      }

      try {
        mounted.paint(mounted.liveDpr);
        const image = resample(mounted.canvas, box, scale, mounted.liveDpr);
        return image ? { image, box, scale, surface } : null;
      } catch {
        stop();
        return null;
      }
    },
    restore: stop,
  };
}

function contentOf(surface: HTMLElement): HTMLElement | null {
  return surface.querySelector<HTMLElement>(`:scope > ${CONTENT_SELECTOR}`);
}

function disabledByPage(): boolean {
  return new URLSearchParams(window.location.search).get(DISABLED_QUERY) === DISABLED_VALUE;
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function surfaceSizeOf(surface: HTMLElement): { w: number; h: number } | null {
  const styles = getComputedStyle(surface);
  const rect = surface.getBoundingClientRect();
  const w = rect.width - px(styles.borderLeftWidth) - px(styles.borderRightWidth);
  const h = rect.height - px(styles.borderTopWidth) - px(styles.borderBottomWidth);
  return w >= 1 && h >= 1 ? { w, h } : null;
}

function clampBox(box: Box, size: { w: number; h: number }): Box {
  const x = Math.min(Math.max(box.x, 0), size.w);
  const y = Math.min(Math.max(box.y, 0), size.h);
  const right = Math.min(Math.max(box.x + box.w, 0), size.w);
  const bottom = Math.min(Math.max(box.y + box.h, 0), size.h);
  return { x, y, w: Math.max(right - x, 0), h: Math.max(bottom - y, 0) };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/**
 * Probes by doing: let the subtree paint, draw it, read the pixels back. Chrome
 * throws until the subtree has a cached paint record, and a silent empty frame
 * is a refusal too.
 */
async function probe(mounted: MountedSurface): Promise<boolean> {
  await nextFrame();
  await nextFrame();

  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    try {
      mounted.paint(mounted.liveDpr);
      if (hasPaint(mounted.canvas)) {
        return true;
      }
    } catch {
      // The paint record can lag the mount by a frame.
    }

    await nextFrame();
  }

  return false;
}

function hasPaint(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context) {
    return false;
  }

  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 3; index < data.length; index += 4 * PROBE_STRIDE) {
    if (data[index] !== undefined && data[index] > 0) {
      return true;
    }
  }

  return false;
}

function mountSurface(surface: HTMLElement, content: HTMLElement): MountedSurface | null {
  const styles = getComputedStyle(surface);
  const size = surfaceSizeOf(surface);
  if (!size || styles.position === "static" || content.parentElement !== surface) {
    // The canvas must position against the surface and hold the whole subtree.
    return null;
  }

  const next = content.nextSibling;
  const inlineHeight = surface.style.height;
  const boxSizing = styles.boxSizing;
  const borderTop = px(styles.borderTopWidth);
  const borderBottom = px(styles.borderBottomWidth);
  const focusAtMount =
    document.activeElement instanceof HTMLElement && content.contains(document.activeElement)
      ? document.activeElement
      : null;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("content", DRAWABLE);
  canvas.setAttribute("layoutsubtree", "");
  canvas.dataset.captureSurface = "";
  Object.assign(canvas.style, {
    position: "absolute",
    inset: "0 auto auto 0",
    display: "block",
    width: `${size.w}px`,
    height: `${size.h}px`,
    // Above the drafting under-layer, below the measurement layers.
    zIndex: "10",
  });

  const root = document.createElement("div");
  root.setAttribute(DRAWABLE, "");
  root.dataset.captureRoot = "";
  Object.assign(root.style, {
    boxSizing: "border-box",
    width: "100%",
    minHeight: "100%",
    paddingTop: styles.paddingTop,
    paddingRight: styles.paddingRight,
    paddingBottom: styles.paddingBottom,
    paddingLeft: styles.paddingLeft,
  });
  canvas.append(root);

  const liveDpr = Math.min(window.devicePixelRatio || 1, LIVE_DPR_LIMIT);
  canvas.width = Math.max(1, Math.round(size.w * liveDpr));
  canvas.height = Math.max(1, Math.round(size.h * liveDpr));

  const context = canvas.getContext("2d") as DrawableContext | null;
  if (!context) {
    return null;
  }

  let restored = false;
  const restore = () => {
    if (restored) {
      return;
    }

    restored = true;
    mountedSurfaces.delete(surface);
    activeRestores.delete(restore);

    const focused =
      document.activeElement instanceof HTMLElement && content.contains(document.activeElement)
        ? document.activeElement
        : null;

    if (content.parentElement === root) {
      root.removeChild(content);
    }

    if (next && next.parentNode === surface) {
      surface.insertBefore(content, next);
    } else {
      surface.append(content);
    }

    canvas.remove();
    surface.style.height = inlineHeight;

    if (focused && focused.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  };

  const paint = (scale: number) => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.drawElementImage(root, 0, 0, size.w, size.h);
  };

  const render = (box: Box, scale: number): HTMLCanvasElement | null => {
    canvas.width = Math.max(1, Math.round(box.w * scale));
    canvas.height = Math.max(1, Math.round(box.h * scale));
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
    context.drawElementImage(root, 0, 0, size.w, size.h);

    const image = document.createElement("canvas");
    image.width = canvas.width;
    image.height = canvas.height;
    const imageContext = image.getContext("2d");
    if (!imageContext) {
      return null;
    }

    imageContext.drawImage(canvas, 0, 0);
    return image;
  };

  try {
    // Keep the surface's height: the canvas is out of flow and cannot hold it.
    surface.style.height =
      boxSizing === "border-box"
        ? `${size.h + borderTop + borderBottom}px`
        : `${size.h - px(styles.paddingTop) - px(styles.paddingBottom)}px`;
    surface.insertBefore(canvas, content);
    root.append(content);
  } catch {
    restore();
    return null;
  }

  mountedSurfaces.add(surface);
  activeRestores.add(restore);
  watchPageHide();
  watchFonts();

  if (focusAtMount && focusAtMount.isConnected && document.activeElement !== focusAtMount) {
    focusAtMount.focus({ preventScroll: true });
  }

  return { canvas, root, width: size.w, height: size.h, liveDpr, paint, render, restore };
}

function resample(
  source: HTMLCanvasElement,
  box: Box,
  scale: number,
  sourceScale: number,
): HTMLCanvasElement | null {
  const image = document.createElement("canvas");
  image.width = Math.max(1, Math.round(box.w * scale));
  image.height = Math.max(1, Math.round(box.h * scale));
  const context = image.getContext("2d");
  if (!context) {
    return null;
  }

  context.drawImage(
    source,
    box.x * sourceScale,
    box.y * sourceScale,
    box.w * sourceScale,
    box.h * sourceScale,
    0,
    0,
    image.width,
    image.height,
  );
  return image;
}

function cacheKey(token: string, scale: number, box: Box): string {
  const rounded = [box.x, box.y, box.w, box.h].map((value) => Math.round(value));
  return `${token}|${scale}|${rounded.join(",")}`;
}

function cachedSnapshot(
  surface: HTMLElement,
  key: string,
  size: { w: number; h: number },
): DrawableSnapshot | null {
  const entries = snapshotCache.get(surface);
  const entry = entries?.find(
    (candidate) =>
      candidate.key === key &&
      candidate.width === size.w &&
      candidate.height === size.h &&
      candidate.fonts === fontsVersion &&
      candidate.generation === cacheGeneration,
  );
  return entry?.snapshot ?? null;
}

function storeSnapshot(
  surface: HTMLElement,
  key: string,
  size: { w: number; h: number },
  snapshot: DrawableSnapshot,
): void {
  const entries = snapshotCache.get(surface) ?? [];
  entries.push({
    key,
    width: size.w,
    height: size.h,
    fonts: fontsVersion,
    generation: cacheGeneration,
    snapshot,
  });

  while (entries.length > CACHE_LIMIT) {
    entries.shift();
  }

  snapshotCache.set(surface, entries);
}

function watchFonts(): void {
  if (fontsWatched) {
    return;
  }

  fontsWatched = true;
  document.fonts.addEventListener("loadingdone", () => {
    fontsVersion += 1;
  });
}

function watchPageHide(): void {
  if (activeRestores.size === 0 || pageHideWatched) {
    return;
  }

  pageHideWatched = true;
  window.addEventListener("pagehide", () => {
    for (const restore of [...activeRestores]) {
      restore();
    }
  });
}
