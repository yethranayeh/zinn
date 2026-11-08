import { drawFillMove } from "./draw";
import { drawScatter, onResize, stepper } from "../texture-slider/canvas";

export interface ProgressHandle {
  set(value: number): void;
}

/** Draws the canvas at its data-value, then animates each new value */
export function setupProgress(canvas: HTMLCanvasElement): ProgressHandle {
  const run = stepper();
  let value = Number(canvas.dataset.value);

  const draw = () => drawScatter(canvas, value, 1);
  draw();
  onResize(canvas, draw);

  return {
    set(next: number) {
      if (next === value) {
        return;
      }

      const from = value;
      value = next;
      // The whole bar takes 12 frames, and any move takes at least 2.
      const frames = Math.max(2, Math.ceil(Math.abs(next - from) * 12));
      run(frames, (frame) => {
        if (frame === frames - 1) {
          drawScatter(canvas, next, 1);
        } else {
          drawFillMove(canvas, from, next, (frame + 1) / frames, frame + 1);
        }
      });
    },
  };
}
