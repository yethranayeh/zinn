const stripColor = "#1c1815";
const baseline = "rgba(28, 24, 21, 0.16)";
/** Keeps the shortest bar visible above the baseline */
const barInset = 3;

/** Sizes the backing store directly, so the monitor's own strips add nothing to the page's frame count */
function size(canvas: HTMLCanvasElement) {
  const box = canvas.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) {
    return null;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * scale);
  canvas.height = Math.round(box.height * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);

  return { context, width: box.width, height: box.height };
}

/** A stepped strip chart: one bar per sample, held until the next */
export function drawStrip(canvas: HTMLCanvasElement, samples: number[]) {
  const sized = size(canvas);
  if (!sized) {
    return;
  }

  const { context, width, height } = sized;
  const slots = 60;
  const values = samples.slice(-slots);
  const max = Math.max(1, ...values);
  const slot = width / slots;

  context.clearRect(0, 0, width, height);
  context.fillStyle = baseline;
  context.fillRect(0, height - 1, width, 1);
  context.fillStyle = stripColor;

  for (const [index, value] of values.entries()) {
    const bar = Math.max(1, (value / max) * (height - barInset));
    context.fillRect(index * slot, height - 1 - bar, Math.max(1, slot - 1), bar);
  }
}
