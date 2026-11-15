import type { Part, Rect, Tone } from "./measure";
import { Overlay, partsOf } from "./measure";

const TONES: Array<Tone> = ["soot", "clay", "cinnabar", "pewter", "bronze"];

export type PlacementSide = "top" | "bottom" | "left" | "right";
export type PlacementAlign = "start" | "center" | "end";

export type Placement = {
  value: string;
  side: PlacementSide;
  align: PlacementAlign;
};

/** Splits `bottom-end` into its side and alignment. */
export function parsePlacement(value: string | null | undefined): Placement {
  const [side = "bottom", align = "end"] = (value ?? "bottom-end").split("-");
  return {
    value: value ?? "bottom-end",
    side: side as PlacementSide,
    align: align as PlacementAlign,
  };
}

const isVertical = (side: PlacementSide) => side === "top" || side === "bottom";

/** The gap between the trigger and the tooltip content on the placement side. */
export function gapOf(trigger: Rect, content: Rect, side: PlacementSide): number {
  switch (side) {
    case "top":
      return trigger.y - (content.y + content.h);
    case "left":
      return trigger.x - (content.x + content.w);
    case "right":
      return content.x - (trigger.x + trigger.w);
    default:
      return content.y - (trigger.y + trigger.h);
  }
}

/** The content edge that shares the trigger's start, center or end on the alignment axis. */
export function alignmentEdgeOf(content: Rect, side: PlacementSide, align: PlacementAlign): number {
  if (isVertical(side)) {
    switch (align) {
      case "start":
        return content.x;
      case "center":
        return content.x + content.w / 2;
      case "end":
        return content.x + content.w;
    }
  }

  switch (align) {
    case "start":
      return content.y;
    case "center":
      return content.y + content.h / 2;
    case "end":
      return content.y + content.h;
  }
}

const byName = (parts: Array<Part>, name: string) => parts.find((part) => part.name === name);

function drawTicks(ov: Overlay, stage: HTMLElement) {
  const { width, height } = stage.getBoundingClientRect();
  const step = 10;
  const major = 100;

  for (let x = 0; x <= width; x += step) {
    const tall = x % major === 0;
    ov.line(x, 0, x, tall ? 10 : 5, {
      tone: "pewter",
      opacity: tall ? 0.9 : 0.35,
      layer: "under",
    });
  }
  for (let y = 0; y <= height; y += step) {
    const tall = y % major === 0;
    ov.line(0, y, tall ? 10 : 5, y, {
      tone: "pewter",
      opacity: tall ? 0.9 : 0.35,
      layer: "under",
    });
  }
}

function drawRulerLabels(stage: HTMLElement): () => void {
  const shell = stage.closest<HTMLElement>("[data-stage-shell]");
  const xGutter = shell?.querySelector<HTMLElement>("[data-ruler-x]");
  const yGutter = shell?.querySelector<HTMLElement>("[data-ruler-y]");
  if (!xGutter || !yGutter) {
    return () => {};
  }

  const marks: Array<HTMLElement> = [];
  const { width, height } = stage.getBoundingClientRect();

  for (let x = 100; x < width - 40; x += 100) {
    const span = document.createElement("span");
    span.textContent = String(x);
    span.style.left = `${x}px`;
    xGutter.append(span);
    marks.push(span);
  }

  for (let y = 100; y < height - 20; y += 100) {
    const span = document.createElement("span");
    span.textContent = String(y);
    span.style.top = `${y}px`;
    yGutter.append(span);
    marks.push(span);
  }

  return () => marks.forEach((mark) => mark.remove());
}

function drawGrid(ov: Overlay, stage: HTMLElement) {
  const { width, height } = stage.getBoundingClientRect();

  for (let x = 40; x < width; x += 40) {
    ov.line(x, 0, x, height, { tone: "pewter", opacity: 0.08, layer: "under" });
  }

  for (let y = 40; y < height; y += 40) {
    ov.line(0, y, width, y, { tone: "pewter", opacity: 0.08, layer: "under" });
  }
}

function factCard(
  ov: Overlay,
  target: HTMLElement,
  parts: Array<Part>,
  placement: Placement,
  gap: number,
) {
  const trigger = byName(parts, "trigger");
  const content = byName(parts, "content");
  const bridge = byName(parts, "bridge");
  if (!trigger || !content || !bridge) return;

  const bridgeSize = isVertical(placement.side)
    ? `${Math.round(bridge.rect.h)}px tall`
    : `${Math.round(bridge.rect.w)}px wide`;

  const card = document.createElement("div");
  card.className = "ov-card";
  card.innerHTML = `
		<p class="ov-card-kicker">specimen · ${target.dataset.inspect ?? "Tooltip"}</p>
		<dl>
			<div><dt>placement</dt><dd>${placement.value}</dd></div>
			<div><dt>gap</dt><dd>${gap}px</dd></div>
			<div><dt>bridge</dt><dd>${bridgeSize} · 1px onto trigger</dd></div>
			<div><dt>align</dt><dd>${placement.align}</dd></div>
		</dl>`;
  ov.labels.append(card);
}

function drawGap(ov: Overlay, trigger: Part, content: Part, side: PlacementSide, gap: number) {
  // A label taller than the gap would cover the trigger or the content.
  const text = gap >= 20 ? `${gap}px gap` : null;

  if (isVertical(side)) {
    const bracketX = trigger.rect.x + trigger.rect.w + 13;
    const [first, second] =
      side === "top"
        ? [content.rect.y + content.rect.h, trigger.rect.y]
        : [trigger.rect.y + trigger.rect.h, content.rect.y];

    ov.dimension(bracketX, first, bracketX, second, text, "clay");
    return;
  }

  const y = trigger.rect.y + trigger.rect.h / 2;
  const [first, second] =
    side === "left"
      ? [content.rect.x + content.rect.w, trigger.rect.x]
      : [trigger.rect.x + trigger.rect.w, content.rect.x];

  ov.dimension(first, y, second, y, text, "clay");
}

function drawAlignment(
  ov: Overlay,
  trigger: Part,
  content: Part,
  placement: Placement,
  stageWidth: number,
) {
  const edge = alignmentEdgeOf(content.rect, placement.side, placement.align);
  const label = `align ${placement.align}`;

  if (isVertical(placement.side)) {
    const top = Math.min(content.rect.y, trigger.rect.y) - 12;
    const bottom = Math.max(content.rect.y + content.rect.h, trigger.rect.y + trigger.rect.h) + 10;

    ov.line(edge, top, edge, bottom, { tone: "cinnabar", dash: "2 4" });

    // Keep the label off the content: start content sits right of the line,
    // end content sits left, centre picks the roomier side.
    const labelWidth = 88;
    const roomLeft = edge - 6 - labelWidth >= 0;
    const roomRight = edge + 6 + labelWidth <= stageWidth;
    const goesRight =
      placement.align === "start"
        ? !roomLeft
        : placement.align === "end"
          ? roomRight
          : roomRight || !roomLeft;

    ov.label(label, goesRight ? edge + 6 : edge - 6, bottom + 4, {
      tone: "cinnabar",
      anchor: goesRight ? "start" : "end",
    });
    return;
  }

  const left = Math.min(content.rect.x, trigger.rect.x) - 12;
  const right = Math.max(content.rect.x + content.rect.w, trigger.rect.x + trigger.rect.w) + 10;

  ov.line(left, edge, right, edge, { tone: "cinnabar", dash: "2 4" });

  const hasRoomRight = right + 6 + 72 <= stageWidth;
  const node = ov.label(label, hasRoomRight ? right + 6 : left - 6, edge, {
    tone: "cinnabar",
    anchor: hasRoomRight ? "start" : "end",
  });
  // Narrow stages cannot fit a side label; the line and the fact card still report the alignment.
  node.dataset.side = "horizontal";
}

export function drawDrafting(stage: HTMLElement, target: HTMLElement): () => void {
  const origin = stage.getBoundingClientRect();
  const ov = new Overlay(stage);
  const parts = partsOf(target, origin);
  const root = parts[0]!;
  const placement = parsePlacement(
    target.querySelector("[data-placement]")?.getAttribute("data-placement"),
  );

  drawGrid(ov, stage);
  drawTicks(ov, stage);
  const removeRuler = drawRulerLabels(stage);

  ov.box(root.rect, { tone: "soot", width: 1.5 });
  ov.cross(root.rect, "cinnabar");

  parts.slice(1).forEach((part, index) => {
    const tone = TONES[(index + 1) % TONES.length]!;
    ov.box(part.rect, { tone, dash: "4 3" });
    if (part.name === "bridge") return;
    const above = part.name === "trigger";
    const label = ov.label(
      `${part.name} · ${Math.round(part.rect.w)}×${Math.round(part.rect.h)}`,
      part.rect.x,
      above ? part.rect.y - 12 : part.rect.y + part.rect.h + 8,
      { tone },
    );
    keepLabelInStage(stage, label, part.rect);
  });

  const trigger = byName(parts, "trigger");
  const content = byName(parts, "content");
  const bridge = byName(parts, "bridge");

  if (trigger && content && bridge) {
    const gap = Math.round(gapOf(trigger.rect, content.rect, placement.side));

    drawGap(ov, trigger, content, placement.side, gap);
    drawAlignment(ov, trigger, content, placement, origin.width);
    ov.hatch(bridge.rect, "clay");
    factCard(ov, target, parts, placement, gap);
  }

  avoidLabelCollisions(stage, ov);

  return () => {
    ov.remove();
    removeRuler();
  };
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Flips a label to the part's other edge when it would leave the stage. */
function keepLabelInStage(stage: HTMLElement, label: HTMLElement, rect: Rect) {
  const stageRect = stage.getBoundingClientRect();
  const box = label.getBoundingClientRect();

  if (box.right > stageRect.right - 4) {
    label.dataset.anchor = "end";
    label.style.left = `${rect.x + rect.w}px`;
  } else if (box.left < stageRect.left + 4) {
    label.dataset.anchor = "start";
    label.style.left = `${Math.max(rect.x, 0)}px`;
  }
}

/** Nudges a label past an earlier one when their boxes overlap. */
function avoidLabelCollisions(stage: HTMLElement, ov: Overlay) {
  const stageRect = stage.getBoundingClientRect();
  const placed: Array<DOMRect> = [];

  for (const label of ov.labels.querySelectorAll<HTMLElement>(".ov-label")) {
    let rect = label.getBoundingClientRect();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const other = placed.find((candidate) => rectsOverlap(rect, candidate));
      if (!other) {
        break;
      }

      const top = Number.parseFloat(label.style.top) || 0;
      const downShift = other.bottom - rect.top + 4;
      if (rect.bottom + downShift <= stageRect.bottom - 4) {
        label.style.top = `${top + downShift}px`;
      } else {
        label.style.top = `${top - (rect.bottom - other.top + 4)}px`;
      }

      rect = label.getBoundingClientRect();
    }

    placed.push(rect);
  }
}
