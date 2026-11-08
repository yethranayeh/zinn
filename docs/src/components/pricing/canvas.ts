import { stepper } from "../ui/texture-slider/canvas";

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
