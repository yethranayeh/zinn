let frames = 0;

/** Frames drawn on the page, one per fit call */
export function framesDrawn() {
  return frames;
}

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

/** Sizes a canvas backing store to its CSS box and returns a context in CSS pixels */
export function fit(canvas: HTMLCanvasElement, height?: number) {
  frames += 1;
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

/** The chance a cell gets a dot, denser near the edge */
export function scatterChance(distance: number, density: number) {
  return (0.28 + 0.65 * Math.max(0, 1 - distance / 20)) * density;
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
      if (noise(x, y) < scatterChance(x - solid, density)) {
        context.fillRect(x, y, 2, 2);
      }
    }
  }

  context.clearRect(0, 0, solid, height);
  context.fillRect(0, 0, solid, height);
}
