import { fit, ink, noise, scatterChance } from "../ui/texture-slider/canvas";

export const FRAME_MS = 125;
export const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  // Runs up to the next grid line, so no gap shows before the first cell.
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
