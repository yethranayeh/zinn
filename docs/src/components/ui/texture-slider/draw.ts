import type { TextureName } from "./variants";
import { drawScatter, fit, ink } from "./canvas";

// A dot every 4 px, with every other row shifted by 2 px
const DOT_PITCH = 4;
const DOT_ROW_OFFSET = 2;
const DOT_FLOOR_RADIUS = 0.75;
const DOT_EDGE_RADIUS = 2.85;
const DOT_FADE_DISTANCE = 48;

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

/** Solid up to edge, then a staggered grid of dots that grow toward the edge */
export function drawHalftone(canvas: HTMLCanvasElement, edge: number) {
  const { context, width, height } = fit(canvas);
  // A whole pixel, so the solid part meets the dots without a half-cleared seam
  const solid = Math.round(width * edge);

  context.clearRect(0, 0, width, height);
  context.fillStyle = ink.soot;

  for (let row = -1; row * DOT_PITCH < height + DOT_PITCH; row += 1) {
    const y = row * DOT_PITCH;
    const offset = Math.abs(row % 2) * DOT_ROW_OFFSET;
    for (let x = -DOT_PITCH; x < width + DOT_PITCH; x += DOT_PITCH) {
      const dotX = x + offset;
      const pastEdge = Math.max(0, dotX - solid);
      const growth = Math.max(0, 1 - pastEdge / DOT_FADE_DISTANCE);
      const radius = DOT_FLOOR_RADIUS + (DOT_EDGE_RADIUS - DOT_FLOOR_RADIUS) * growth;
      context.beginPath();
      context.arc(dotX, y, radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.clearRect(0, 0, solid, height);
  context.fillRect(0, 0, solid, height);
}

export const painters: Record<TextureName, (canvas: HTMLCanvasElement, edge: number) => void> = {
  rules: drawRules,
  scatter: (canvas, edge) => drawScatter(canvas, edge, 1),
  halftone: drawHalftone,
};
