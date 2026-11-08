import { fit, ink, noise, scatterChance } from "../texture-slider/canvas";

/**
 * Fills the track between two edges out of dots, then draws the texture beyond it.
 * `revealed` runs from 0 to 1, and `frame` reshuffles the texture
 */
export function drawFillMove(
  canvas: HTMLCanvasElement,
  from: number,
  to: number,
  revealed: number,
  frame: number,
) {
  const { context, width, height } = fit(canvas);
  const lower = Math.min(from, to) * width;
  const upper = Math.max(from, to) * width;
  const growing = to > from;

  context.clearRect(0, 0, width, height);
  context.fillStyle = ink.soot;
  // Runs up to the next grid line, so no gap shows before the first cell
  context.fillRect(0, 0, Math.ceil(lower / 4) * 4, height);

  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      if (x < lower) {
        continue;
      }

      if (x < upper) {
        const solid = growing ? noise(x, y) <= revealed : noise(x, y) > revealed;
        if (solid) {
          context.fillRect(x, y, 4, 4);
          continue;
        }
      }

      if (noise(x + frame, y) < scatterChance(x - lower, 1)) {
        context.fillRect(x, y, 2, 2);
      }
    }
  }
}
