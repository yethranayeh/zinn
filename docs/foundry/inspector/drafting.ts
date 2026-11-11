import type { Part, Tone } from "./measure";
import { Overlay, partsOf } from "./measure";

const TONES: Array<Tone> = ["soot", "clay", "cinnabar", "pewter", "bronze"];

const byName = (parts: Array<Part>, name: string) => parts.find((part) => part.name === name);

function drawTicks(ov: Overlay, stage: HTMLElement) {
  const { width, height } = stage.getBoundingClientRect();
  const step = 10;
  const major = 100;

  for (let x = 0; x <= width; x += step) {
    const tall = x % major === 0;
    ov.line(x, 0, x, tall ? 10 : 5, { tone: "pewter", opacity: tall ? 0.9 : 0.35 });
  }
  for (let y = 0; y <= height; y += step) {
    const tall = y % major === 0;
    ov.line(0, y, tall ? 10 : 5, y, { tone: "pewter", opacity: tall ? 0.9 : 0.35 });
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
    ov.line(x, 0, x, height, { tone: "pewter", opacity: 0.08 });
  }

  for (let y = 40; y < height; y += 40) {
    ov.line(0, y, width, y, { tone: "pewter", opacity: 0.08 });
  }
}

function factCard(ov: Overlay, target: HTMLElement, parts: Array<Part>) {
  const placement = target.querySelector("[data-placement]")?.getAttribute("data-placement") ?? "—";
  const trigger = byName(parts, "trigger");
  const bubble = byName(parts, "bubble");
  const bridge = byName(parts, "bridge");
  if (!trigger || !bubble || !bridge) return;
  const gap = Math.round(bubble.rect.y - (trigger.rect.y + trigger.rect.h));

  const card = document.createElement("div");
  card.className = "ov-card";
  card.innerHTML = `
		<p class="ov-card-kicker">specimen · ${target.dataset.inspect ?? "Tooltip"}</p>
		<dl>
			<div><dt>placement</dt><dd>${placement}</dd></div>
			<div><dt>gap</dt><dd>${gap}px</dd></div>
			<div><dt>bridge</dt><dd>${Math.round(bridge.rect.h)}px tall · 1px onto trigger</dd></div>
			<div><dt>align</dt><dd>${placement.split("-")[1]} edge</dd></div>
		</dl>`;
  ov.labels.append(card);
}

export function drawDrafting(stage: HTMLElement, target: HTMLElement): () => void {
  const origin = stage.getBoundingClientRect();
  const ov = new Overlay(stage);
  const parts = partsOf(target, origin);
  const root = parts[0]!;

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
    ov.label(
      `${part.name} · ${Math.round(part.rect.w)}×${Math.round(part.rect.h)}`,
      part.rect.x,
      above ? part.rect.y - 12 : part.rect.y + part.rect.h + 8,
      { tone },
    );
  });

  const trigger = byName(parts, "trigger");
  const bubble = byName(parts, "bubble");
  const bridge = byName(parts, "bridge");

  if (trigger && bubble && bridge) {
    const gap = Math.round(bubble.rect.y - (trigger.rect.y + trigger.rect.h));
    const bracketX = trigger.rect.x + trigger.rect.w + 13;
    const gapTop = trigger.rect.y + trigger.rect.h;

    ov.line(bracketX, gapTop, trigger.rect.x + trigger.rect.w + 5, gapTop, { tone: "clay" });
    ov.line(bracketX, bubble.rect.y, trigger.rect.x + trigger.rect.w + 5, bubble.rect.y, {
      tone: "clay",
    });
    ov.line(bracketX, gapTop, bracketX, bubble.rect.y, { tone: "clay" });
    ov.label(`${gap}px gap`, bracketX + 6, (gapTop + bubble.rect.y) / 2, { tone: "clay" });
    ov.hatch(bridge.rect, "clay");

    const edge = bubble.rect.x + bubble.rect.w;
    ov.line(edge, bubble.rect.y - 12, edge, bubble.rect.y + bubble.rect.h + 10, {
      tone: "cinnabar",
      dash: "2 4",
    });
    ov.label("aligned end", edge + 6, bubble.rect.y + bubble.rect.h + 14, { tone: "cinnabar" });

    factCard(ov, target, parts);
  }

  return () => {
    ov.remove();
    removeRuler();
  };
}
