export const FRAME_MS = 125;
export const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const styles = getComputedStyle(document.documentElement);
const token = (name: string) => styles.getPropertyValue(name).trim();
export const ink = {
  soot: token("--color-soot"),
  bone: token("--color-bone"),
};

/** A stable pseudo-random value for a grid cell, so textures do not shimmer between redraws */
export function noise(x: number, y: number) {
  const seed = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return seed - Math.floor(seed);
}

/**
 * Runs `onFrame` for frames steps at the stepped rate.
 * Starting again cancels the previous run.
 */
export function stepper() {
  let timer = 0;
  return (frames: number, onFrame: (frame: number) => void) => {
    window.clearInterval(timer);
    if (reducedMotion) {
      onFrame(frames - 1);
      return;
    }

    let frame = 0;
    onFrame(frame);

    timer = window.setInterval(() => {
      frame += 1;
      onFrame(frame);
      if (frame >= frames - 1) {
        window.clearInterval(timer);
      }
    }, FRAME_MS);
  };
}

const printers = new WeakMap<HTMLElement, ReturnType<typeof stepper>>();

/** Prints text in a few uneven chunks */
export function print(element: HTMLElement, text: string) {
  const run = printers.get(element) ?? stepper();

  printers.set(element, run);

  const frames = 4;
  run(frames, (frame) => {
    const shown =
      frame >= frames - 1 ? text.length : Math.ceil(text.length * ((frame + 1) / frames) ** 2);
    element.textContent = text.slice(0, shown);
  });
}

/** Sizes a canvas backing store to its CSS box and returns a context in CSS pixels */
export function fit(canvas: HTMLCanvasElement, height?: number) {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("no 2d context");
  }

  const box = canvas.getBoundingClientRect();
  const width = box.width;
  const cssHeight = height ?? box.height;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(cssHeight * scale);

  if (height !== undefined) {
    canvas.style.height = `${height}px`;
  }

  context.setTransform(scale, 0, 0, scale, 0, 0);
  return { context, width, height: cssHeight };
}

export function onResize(element: Element, redraw: () => void) {
  let lastWidth = -1;

  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width !== lastWidth) {
      lastWidth = entry.contentRect.width;
      redraw();
    }
  }).observe(element);
}

/**
 * Solid up to edge, then scattered pixels that thin out with distance.
 * `density` scales the scatter
 */
export function drawScatter(canvas: HTMLCanvasElement, edge: number, density: number) {
  const { context, width, height } = fit(canvas);
  const solid = width * edge;

  context.clearRect(0, 0, width, height);
  context.fillStyle = ink.soot;

  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const distance = x - solid;
      const chance = (0.28 + 0.65 * Math.max(0, 1 - distance / 20)) * density;
      if (noise(x, y) < chance) {
        context.fillRect(x, y, 2, 2);
      }
    }
  }

  context.clearRect(0, 0, solid, height);
  context.fillRect(0, 0, solid, height);
}

/** Solid up to edge, then evenly spaced vertical rules */
export function drawRules(canvas: HTMLCanvasElement, edge: number) {
  const { context, width, height } = fit(canvas);
  const solid = width * edge;
  context.clearRect(0, 0, width, height);
  context.fillStyle = ink.soot;

  for (let x = 0; x < width; x += 12) {
    context.fillRect(x, 0, 2, height);
  }

  context.clearRect(0, 0, solid, height);
  context.fillRect(0, 0, solid, height);
}
