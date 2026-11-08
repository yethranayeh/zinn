import { fit, ink, noise, onResize, stepper } from "../ui/texture-slider/canvas";

const glyphs: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00", "00", "00", "00", "00", "11", "11"],
  " ": ["00", "00", "00", "00", "00", "00", "00"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
};

const numeralRows = 7;
const numeralPadCols = 2;
const maxCell = 13;

export function setupDotNumeral() {
  const holder = document.querySelector<HTMLElement>("[data-dotnum]");
  const text = holder?.querySelector<HTMLElement>("[data-dotnum-text]");

  if (!holder || !text) {
    return { show: (_value: string) => {} };
  }

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  holder.prepend(canvas);
  text.classList.add("sr-only");

  const run = stepper();
  let current = text.textContent?.trim() ?? "";

  function cells(value: string) {
    const lit: Array<[number, number]> = [];
    let column = 0;
    for (const character of value) {
      const glyph = glyphs[character] ?? glyphs[" "];
      glyph.forEach((row, y) => {
        [...row].forEach((bit, x) => {
          if (bit === "1") {
            lit.push([column + x, y]);
          }
        });
      });
      column += glyph[0].length + 1;
    }
    return { lit, columns: column - 1 };
  }

  function draw(value: string, revealed: number) {
    const box = holder!.getBoundingClientRect();
    const { lit, columns } = cells(value);
    const cell = Math.min(maxCell, Math.floor(box.width / (columns + numeralPadCols)));
    const { context, width, height } = fit(canvas, cell * numeralRows);
    context.clearRect(0, 0, width, height);
    const radius = cell * 0.4;
    const allColumns = Math.floor(width / cell);
    context.fillStyle = ink.bone;

    for (let y = 0; y < numeralRows; y++) {
      for (let x = 0; x < allColumns; x++) {
        context.beginPath();
        context.arc(x * cell + cell / 2, y * cell + cell / 2, radius * 0.45, 0, Math.PI * 2);
        context.fill();
      }
    }

    context.fillStyle = ink.soot;
    for (const [x, y] of lit) {
      if (noise(x, y) <= revealed) {
        context.beginPath();
        context.arc(x * cell + cell / 2, y * cell + cell / 2, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  onResize(holder, () => draw(current, 1));
  return {
    show(value: string) {
      current = value;
      text.textContent = value;
      const frames = 5;
      run(frames, (frame) => draw(value, (frame + 1) / frames));
    },
  };
}
