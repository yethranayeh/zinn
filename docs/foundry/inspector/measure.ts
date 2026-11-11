export type Rect = { x: number; y: number; w: number; h: number };

export type Part = {
  name: string;
  source: string;
  note?: string;
  rect: Rect;
  depth: number;
  el?: Element;
};

const SVG = "http://www.w3.org/2000/svg";

export function rectOf(el: Element, origin: DOMRect): Rect {
  const r = el.getBoundingClientRect();

  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
}

export function pseudoRect(el: Element, pseudo: string, origin: DOMRect): Rect | null {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el, pseudo);

  if (s.content === "none") {
    return null;
  }

  const px = (v: string) => (v === "auto" ? 0 : parseFloat(v));
  return {
    x: r.left - origin.left + px(s.left),
    y: r.top - origin.top + px(s.top),
    w: parseFloat(s.width),
    h: parseFloat(s.height),
  };
}

function depthOf(el: Element, root: Element) {
  let depth = 0;
  let node: Element | null = el;

  while (node && node !== root) {
    depth += 1;
    node = node.parentElement;
  }

  return depth;
}

function nameOf(el: HTMLElement): { name: string; source: string } {
  const declared = el.dataset.part;
  if (declared) {
    return { name: declared, source: "data-part" };
  }
  if (el.getAttribute("role") === "tooltip") {
    return { name: "bubble", source: 'role="tooltip"' };
  }
  if (el.matches("button")) {
    return { name: "trigger", source: "<button>" };
  }
  if (el.matches("a[href]")) {
    return { name: "trigger", source: "<a href>" };
  }
  return { name: el.tagName.toLowerCase(), source: el.tagName.toLowerCase() };
}

export function partsOf(root: HTMLElement, origin: DOMRect) {
  const declaredName = root.dataset.inspect?.trim();
  const parts: Array<Part> = [
    {
      name: declaredName || "element",
      source: declaredName ? "data-inspect" : "component root",
      rect: rectOf(root, origin),
      depth: 0,
      el: root,
    },
  ];

  const bubble = root.querySelector<HTMLElement>('[role="tooltip"]');
  const marked = [
    ...root.querySelectorAll<HTMLElement>('[data-part], [role="tooltip"], button, a[href]'),
  ];

  for (const el of marked) {
    if (parts.some((part) => part.el === el)) continue;
    const { name, source } = nameOf(el);
    const placement = el.dataset.placement;
    parts.push({
      name,
      source,
      note: placement ? `placement="${placement}"` : undefined,
      rect: rectOf(el, origin),
      depth: depthOf(el, root),
      el,
    });
  }

  if (bubble) {
    const bridge = pseudoRect(bubble, "::before", origin);

    if (bridge) {
      parts.push({
        name: "bridge",
        source: "::before",
        note: "covers the 7px gap, 1px onto the trigger",
        rect: bridge,
        depth: depthOf(bubble, root) + 1,
        el: bubble,
      });
    }
  }

  return parts;
}

export type Tone = "soot" | "clay" | "cinnabar" | "pewter" | "bronze";

type BoxOptions = { tone?: Tone; width?: number; dash?: string; fill?: number };

export class Overlay {
  readonly stage: HTMLElement;
  readonly svg: SVGSVGElement;
  readonly labels: HTMLElement;

  constructor(stage: HTMLElement) {
    this.stage = stage;
    stage.querySelectorAll(".ov").forEach((node) => node.remove());

    this.svg = document.createElementNS(SVG, "svg");
    this.svg.setAttribute("class", "ov ov-lines");
    this.svg.setAttribute("aria-hidden", "true");

    this.labels = document.createElement("div");
    this.labels.className = "ov ov-labels";
    this.labels.setAttribute("aria-hidden", "true");

    stage.append(this.svg, this.labels);
    this.resize();
  }

  resize() {
    const { width, height } = this.stage.getBoundingClientRect();
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(height));
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options: { tone?: Tone; width?: number; dash?: string; opacity?: number } = {},
  ) {
    const line = document.createElementNS(SVG, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", `var(--tone-${options.tone ?? "soot"})`);
    line.setAttribute("stroke-width", String(options.width ?? 1));

    if (options.dash) {
      line.setAttribute("stroke-dasharray", options.dash);
    }

    if (options.opacity !== undefined) {
      line.setAttribute("opacity", String(options.opacity));
    }

    this.svg.append(line);
    return line;
  }

  box(rect: Rect, options: BoxOptions = {}) {
    const node = document.createElementNS(SVG, "rect");
    node.setAttribute("x", String(rect.x));
    node.setAttribute("y", String(rect.y));
    node.setAttribute("width", String(rect.w));
    node.setAttribute("height", String(rect.h));
    node.setAttribute("fill", options.fill ? `var(--tone-${options.tone ?? "soot"})` : "none");
    node.setAttribute("fill-opacity", String(options.fill ?? 0));
    node.setAttribute("stroke", `var(--tone-${options.tone ?? "soot"})`);
    node.setAttribute("stroke-width", String(options.width ?? 1));

    if (options.dash) {
      node.setAttribute("stroke-dasharray", options.dash);
    }

    this.svg.append(node);
    return node;
  }

  hatch(rect: Rect, tone: Tone = "clay") {
    const node = document.createElement("div");
    node.className = `ov-hatch tone-${tone}`;

    Object.assign(node.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
    });

    this.labels.append(node);
    return node;
  }

  label(
    text: string,
    x: number,
    y: number,
    options: {
      anchor?: "start" | "middle" | "end";
      tone?: Tone;
      dx?: number;
      dy?: number;
      strong?: boolean;
    } = {},
  ) {
    const node = document.createElement("div");
    node.className = `ov-label tone-${options.tone ?? "soot"}${options.strong ? " is-strong" : ""}`;
    node.textContent = text;
    node.dataset.anchor = options.anchor ?? "start";
    node.style.left = `${x + (options.dx ?? 0)}px`;
    node.style.top = `${y + (options.dy ?? 0)}px`;
    this.labels.append(node);
    return node;
  }

  badge(text: string, x: number, y: number, tone: Tone = "soot") {
    const node = this.label(text, x, y, { anchor: "start", tone });
    node.classList.add("is-badge");
    return node;
  }

  dimension(x1: number, y1: number, x2: number, y2: number, text: string, tone: Tone = "soot") {
    this.line(x1, y1, x2, y2, { tone });

    const horizontal = Math.abs(y2 - y1) < 1;
    const tick = 5;

    if (horizontal) {
      this.line(x1, y1 - tick, x1, y1 + tick, { tone });
      this.line(x2, y2 - tick, x2, y2 + tick, { tone });
      this.label(text, (x1 + x2) / 2, y1, { anchor: "middle", tone, dy: -9 });
    } else {
      this.line(x1 - tick, y1, x1 + tick, y1, { tone });
      this.line(x2 - tick, y2, x2 + tick, y2, { tone });
      this.label(text, x1, (y1 + y2) / 2, { anchor: "middle", tone, dx: 12 });
    }
  }

  cross(rect: Rect, tone: Tone = "clay") {
    this.line(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, { tone, dash: "3 3" });
    this.line(rect.x + rect.w, rect.y, rect.x, rect.y + rect.h, { tone, dash: "3 3" });
  }

  remove() {
    this.svg.remove();
    this.labels.remove();
  }
}
