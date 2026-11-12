import type { Rect, Tone } from "./measure";

import { fit, stepper } from "../../src/components/ui/texture-slider/canvas";
import { partsOf } from "./measure";

const TONES: Array<Tone> = ["soot", "clay", "cinnabar", "pewter", "bronze"];

/** Paired x and y components of a direction, in stage pixels. */
type Direction = [number, number];

const EXPLODE: Record<string, Direction> = {
  trigger: [-1, -0.12],
  bubble: [0, 1],
  bridge: [1, 0.12],
};

export type ExplodeHandle = {
  readonly canExplode: boolean;
  setExploded(exploded: boolean, animate?: boolean): void;
  cleanup(): void;
};

function unitX(dx: number, dy: number, fallback: Direction): Direction {
  const length = Math.hypot(dx, dy);
  if (length < 1) {
    return fallback;
  }
  return [dx / length, dy / length];
}

function dottedLine(
  context: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
) {
  const steps = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 4));
  context.fillStyle = color;
  for (let i = 0; i <= steps; i++) {
    context.fillRect(
      Math.round(x1 + ((x2 - x1) * i) / steps),
      Math.round(y1 + ((y2 - y1) * i) / steps),
      2,
      2,
    );
  }
}

/** Lifts the measured parts into dot plates while the Drafting layer stays anchored. */
export function drawExplode(stage: HTMLElement, target: HTMLElement): ExplodeHandle {
  const origin = stage.getBoundingClientRect();
  const parts = partsOf(target, origin);
  const root = parts[0]!;
  const canExplode = parts.length > 1;

  if (!canExplode) {
    return { canExplode: false, setExploded: () => {}, cleanup: () => {} };
  }

  const styles = getComputedStyle(stage);
  const colors = TONES.map((name) => styles.getPropertyValue(`--tone-${name}`).trim());
  const run = stepper();

  const canvas = document.createElement("canvas");
  canvas.className = "ov ov-explode";
  canvas.setAttribute("aria-hidden", "true");
  stage.append(canvas);

  const layer = document.createElement("div");
  layer.className = "ov ov-dot-labels";
  layer.setAttribute("aria-hidden", "true");
  stage.append(layer);

  const labels = parts.map((part, index) => {
    if (part === root) {
      return null;
    }

    const label = document.createElement("div");
    label.className = "ov-dot-label";
    if (part.rect.h < 20) {
      label.classList.add("is-thin");
    }
    label.dataset.tone = TONES[index % TONES.length]!;
    label.textContent = part.name;

    const size = document.createElement("b");
    size.textContent = `${Math.round(part.rect.w)}×${Math.round(part.rect.h)}`;
    label.append(size);
    label.hidden = true;
    layer.append(label);
    return label;
  });

  const partLabels = [...stage.querySelectorAll<HTMLElement>(".ov-labels > .ov-label")].filter(
    (label) =>
      parts
        .slice(1)
        .some((part) => part.name !== "bridge" && label.textContent?.startsWith(`${part.name} ·`)),
  );
  const card = stage.querySelector<HTMLElement>(".ov-card");

  const destinations = parts.map((part) => {
    if (part === root) {
      return part.rect;
    }

    const cx = part.rect.x + part.rect.w / 2;
    const cy = part.rect.y + part.rect.h / 2;
    const rootCx = root.rect.x + root.rect.w / 2;
    const rootCy = root.rect.y + root.rect.h / 2;
    const [ux, uy] = EXPLODE[part.name] ?? unitX(cx - rootCx, cy - rootCy, [0, -1]);
    const distance =
      part.name === "bubble"
        ? 84
        : part.name === "bridge"
          ? 112
          : part.name === "trigger"
            ? 64
            : 52 + part.depth * 12;

    return {
      ...part.rect,
      x: part.rect.x + Math.round(ux * distance),
      y: part.rect.y + Math.round(uy * distance),
    };
  });

  let exploded = false;
  let runId = 0;
  let cancelled = false;

  const setContentHidden = (hidden: boolean) => {
    for (const label of partLabels) {
      label.style.visibility = hidden ? "hidden" : "";
    }
    if (card) {
      card.style.visibility = hidden ? "hidden" : "";
    }
  };

  const draw = (progress: number) => {
    if (cancelled) {
      return;
    }

    const { context, width, height } = fit(canvas);
    context.clearRect(0, 0, width, height);

    if (progress <= 0) {
      for (const label of labels) {
        if (label) {
          label.hidden = true;
        }
      }
      if (!exploded) {
        stage.removeAttribute("data-exploded");
        setContentHidden(false);
      }
      return;
    }

    parts.forEach((part, index) => {
      if (part === root) {
        return;
      }

      const destination = destinations[index]!;
      const rect: Rect = {
        x: part.rect.x + (destination.x - part.rect.x) * progress,
        y: part.rect.y + (destination.y - part.rect.y) * progress,
        w: part.rect.w,
        h: part.rect.h,
      };
      const color = colors[index % colors.length]!;
      const [ux, uy] =
        EXPLODE[part.name] ??
        unitX(destination.x - part.rect.x, destination.y - part.rect.y, [0, -1]);

      const from = {
        x: part.rect.x + part.rect.w / 2 + (ux * part.rect.w) / 2,
        y: part.rect.y + part.rect.h / 2 + (uy * part.rect.h) / 2,
      };
      const to = {
        x: rect.x + rect.w / 2 - (ux * rect.w) / 2,
        y: rect.y + rect.h / 2 - (uy * rect.h) / 2,
      };
      dottedLine(context, from.x, from.y, to.x, to.y, color);

      context.fillStyle = color;
      for (let y = 0; y < rect.h; y += 4) {
        for (let x = 0; x < rect.w; x += 4) {
          context.fillRect(Math.round(rect.x + x), Math.round(rect.y + y), 2, 2);
        }
      }

      const label = labels[index];
      if (!label) {
        return;
      }
      if (part.rect.h < 20) {
        label.style.left = `${Math.round(rect.x + rect.w + 6)}px`;
        label.style.top = `${Math.round(rect.y + rect.h / 2)}px`;
      } else {
        label.style.left = `${Math.round(rect.x)}px`;
        label.style.top = `${Math.round(rect.y - 4)}px`;
      }
      label.hidden = !exploded || progress < 1;
    });
  };

  const setExploded = (next: boolean, animate = true) => {
    const shouldExplode = canExplode ? next : false;
    if (shouldExplode === exploded) {
      if (!animate) {
        runId += 1;
        draw(shouldExplode ? 1 : 0);
      }
      return;
    }

    exploded = shouldExplode;
    runId += 1;
    const id = runId;
    if (exploded) {
      stage.setAttribute("data-exploded", "");
      setContentHidden(true);
    } else {
      for (const label of labels) {
        if (label) {
          label.hidden = true;
        }
      }
    }

    if (!animate) {
      draw(exploded ? 1 : 0);
      return;
    }

    const order = exploded ? [0, 0.5, 1] : [1, 0.5, 0];
    run(3, (frame) => {
      if (id === runId) {
        draw(order[frame]!);
      }
    });
  };

  return {
    canExplode,
    setExploded,
    cleanup() {
      cancelled = true;
      runId += 1;
      canvas.remove();
      layer.remove();
      stage.removeAttribute("data-exploded");
      setContentHidden(false);
    },
  };
}
