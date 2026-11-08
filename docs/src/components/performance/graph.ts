import type { Flow, FlowLink, FlowNode, FlowPort } from "./flow-data";
import { kindColors, kindLabels, kindText, type NodeKind } from "./flow-palette";

export interface GraphTheme {
  background: string;
  grid: string;
  gridStyle: "dots" | "lines";
  nodeFill: string;
  nodeBorder: string;
  nodeBorderSelected: string;
  rowLine: string;
  label: string;
  value: string;
  link: string;
  linkActive: string;
  linkLabel: string;
  linkLabelBg: string;
  portFill: string;
  shadow?: string;
}

export interface GraphOptions {
  theme: GraphTheme;
  flow: Flow;
  interactive?: boolean;
  linkLabels?: boolean;
  numbered?: boolean;
  dimOnSelect?: boolean;
  portSides?: "auto" | "horizontal";
  nodeWidth?: number;
  padding?: number;
  compact?: boolean;
  onSelect?: (node: FlowNode | null) => void;
  onHover?: (node: FlowNode | null) => void;
  onTraceEnd?: () => void;
}

type Side = "left" | "right" | "top" | "bottom";

interface Point {
  x: number;
  y: number;
}

interface LinkPoints {
  start: Point;
  control1: Point;
  control2: Point;
  end: Point;
}

interface TraceEntry {
  link: FlowLink;
  start: number;
  duration: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Canvas cannot read custom properties, so resolve var() and nested var() once at mount. */
function resolveCssValue(value: string, style: CSSStyleDeclaration) {
  let current = value;
  for (let index = 0; index < 10 && current.includes("var("); index++) {
    const next = current.replace(/var\((--[^)]+)\)/g, (_match, name: string) => {
      return style.getPropertyValue(name).trim() || `var(${name})`;
    });
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

function resolveTheme(theme: GraphTheme, style: CSSStyleDeclaration): GraphTheme {
  return {
    ...theme,
    background: resolveCssValue(theme.background, style),
    grid: resolveCssValue(theme.grid, style),
    nodeFill: resolveCssValue(theme.nodeFill, style),
    nodeBorder: resolveCssValue(theme.nodeBorder, style),
    nodeBorderSelected: resolveCssValue(theme.nodeBorderSelected, style),
    rowLine: resolveCssValue(theme.rowLine, style),
    label: resolveCssValue(theme.label, style),
    value: resolveCssValue(theme.value, style),
    link: resolveCssValue(theme.link, style),
    linkActive: resolveCssValue(theme.linkActive, style),
    linkLabel: resolveCssValue(theme.linkLabel, style),
    linkLabelBg: resolveCssValue(theme.linkLabelBg, style),
    portFill: resolveCssValue(theme.portFill, style),
    shadow: theme.shadow ? resolveCssValue(theme.shadow, style) : undefined,
  };
}

function resolveColorMap<T extends string>(
  colors: Record<T, string>,
  style: CSSStyleDeclaration,
): Record<T, string> {
  const entries = Object.entries(colors).map(([kind, value]) => {
    return [kind, resolveCssValue(value as string, style)];
  });
  return Object.fromEntries(entries) as Record<T, string>;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function topRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height);
  ctx.lineTo(x, y + height);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function bezierPoint(points: LinkPoints, t: number): Point {
  const mt = 1 - t;
  const a = mt ** 3;
  const b = 3 * mt ** 2 * t;
  const c = 3 * mt * t ** 2;
  const d = t ** 3;
  return {
    x: a * points.start.x + b * points.control1.x + c * points.control2.x + d * points.end.x,
    y: a * points.start.y + b * points.control1.y + c * points.control2.y + d * points.end.y,
  };
}

export class GraphCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly theme: GraphTheme;
  private readonly nodeColors: Record<NodeKind, string>;
  private readonly nodeText: Record<NodeKind, string>;
  private readonly badgeFill: string;
  private readonly badgeText: string;
  private readonly interactive: boolean;
  private readonly linkLabels: boolean;
  private readonly numbered: boolean;
  private readonly dimOnSelect: boolean;
  private readonly portSides: "auto" | "horizontal";
  private readonly nodeWidth: number;
  private readonly padding: number;
  private readonly compact: boolean;
  private readonly headerHeight: number;
  private readonly rowHeight: number;
  private readonly padY: number;
  private readonly onSelect?: (node: FlowNode | null) => void;
  private readonly onHover?: (node: FlowNode | null) => void;
  private readonly onTraceEnd?: () => void;

  private nodes: Array<FlowNode>;
  private links: Array<FlowLink>;
  private transform = { x: 0, y: 0, scale: 1 };
  private dpr = 1;
  private width = 0;
  private height = 0;
  private selected: string | null = null;
  private hovered: string | null = null;
  private autoFit = true;
  private drag:
    | { type: "node"; id: string; offsetX: number; offsetY: number }
    | { type: "pan"; startX: number; startY: number; tx: number; ty: number }
    | null = null;
  private pointerStart: Point | null = null;
  private moved = false;
  private observer: ResizeObserver;
  private frame = 0;
  private reducedTimer = 0;
  private traceEntries: Array<TraceEntry> = [];
  private traceStart = 0;
  private traceNow = 0;
  private traceTotal = 0;
  private traceActive = false;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement, options: GraphOptions) {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D is unavailable.");
    }
    this.canvas = canvas;
    this.ctx = ctx;
    const style = getComputedStyle(document.documentElement);
    this.theme = resolveTheme(options.theme, style);
    this.nodeColors = resolveColorMap(kindColors, style);
    this.nodeText = resolveColorMap(kindText, style);
    this.badgeFill = resolveCssValue("var(--color-cinnabar)", style);
    this.badgeText = resolveCssValue("var(--color-limestone)", style);
    this.interactive = options.interactive ?? false;
    this.linkLabels = options.linkLabels ?? true;
    this.numbered = options.numbered ?? false;
    this.dimOnSelect = options.dimOnSelect ?? false;
    this.portSides = options.portSides ?? "auto";
    this.compact = options.compact ?? false;
    this.nodeWidth = this.compact
      ? Math.min(options.nodeWidth ?? 200, 150)
      : (options.nodeWidth ?? 200);
    this.padding = options.padding ?? 40;
    this.headerHeight = this.compact ? 24 : 30;
    this.rowHeight = this.compact ? 16 : 22;
    this.padY = this.compact ? 6 : 8;
    this.onSelect = options.onSelect;
    this.onHover = options.onHover;
    this.onTraceEnd = options.onTraceEnd;
    this.nodes = this.cloneNodes(options.flow);
    this.links = options.flow.links;

    this.canvas.style.touchAction = this.interactive ? "none" : "pan-y";
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);
    this.canvas.addEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.handleDoubleClick);
    this.canvas.addEventListener("keydown", this.handleKeyDown);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.canvas.parentElement ?? this.canvas);
    this.resize();
    document.fonts.ready.then(() => {
      if (!this.destroyed) {
        this.draw();
      }
    });
  }

  private cloneNodes(flow: Flow): Array<FlowNode> {
    return flow.nodes.map((node) => ({
      ...node,
      rows: node.rows.map((row) => ({ ...row })),
      inputs: node.inputs?.map((port) => ({ ...port })),
      outputs: node.outputs?.map((port) => ({ ...port })),
    }));
  }

  setFlow(flow: Flow) {
    this.nodes = this.cloneNodes(flow);
    this.links = flow.links;
    this.selected = null;
    this.hovered = null;
    this.autoFit = true;
    this.cancelTrace();
    this.fit();
    this.onSelect?.(null);
  }

  select(id: string | null) {
    this.selected = id;
    this.draw();
    const node = id ? (this.nodes.find((entry) => entry.id === id) ?? null) : null;
    this.onSelect?.(node);
  }

  highlight(id: string | null) {
    if (this.hovered === id) {
      return;
    }
    this.hovered = id;
    this.draw();
    const node = id ? (this.nodes.find((entry) => entry.id === id) ?? null) : null;
    this.onHover?.(node);
  }

  get selectedId() {
    return this.selected;
  }

  fit() {
    if (this.width === 0 || this.height === 0) {
      return;
    }
    const bounds = this.bounds();
    const availableWidth = Math.max(1, this.width - this.padding * 2);
    const availableHeight = Math.max(1, this.height - this.padding * 2);
    const scale = clamp(
      Math.min(availableWidth / bounds.width, availableHeight / bounds.height),
      0.18,
      this.compact ? 1 : 1.1,
    );
    this.transform.scale = scale;
    this.transform.x = (this.width - bounds.width * scale) / 2 - bounds.minX * scale;
    this.transform.y = (this.height - bounds.height * scale) / 2 - bounds.minY * scale;
    this.autoFit = true;
    this.draw();
  }

  focus(id: string) {
    const node = this.nodes.find((entry) => entry.id === id);
    if (!node) {
      return;
    }
    const scale = Math.max(this.transform.scale, 0.9);
    this.transform.scale = scale;
    this.transform.x = this.width / 2 - (node.x + this.nodeWidth / 2) * scale;
    this.transform.y = this.height / 2 - (node.y + this.nodeHeight(node) / 2) * scale;
    this.autoFit = false;
    this.draw();
  }

  trace() {
    this.cancelTrace();
    if (this.links.length === 0) {
      this.onTraceEnd?.();
      return;
    }
    this.traceActive = true;
    this.traceStart = performance.now();
    this.traceNow = this.traceStart;
    if (this.reducedMotion) {
      this.traceEntries = this.links.map((link) => ({ link, start: 0, duration: 1 }));
      this.traceTotal = 1;
      this.traceNow = this.traceStart + 1;
      this.draw();
      this.reducedTimer = window.setTimeout(() => {
        if (this.destroyed) {
          return;
        }
        this.traceActive = false;
        this.traceEntries = [];
        this.draw();
        this.onTraceEnd?.();
      }, 350);
      return;
    }
    this.traceEntries = this.links.map((link, index) => ({
      link,
      start: index * 150,
      duration: 500,
    }));
    this.traceTotal = this.traceEntries.reduce(
      (total, entry) => Math.max(total, entry.start + entry.duration),
      0,
    );
    this.frame = requestAnimationFrame(this.animateTrace);
  }

  private cancelTrace() {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    if (this.reducedTimer) {
      window.clearTimeout(this.reducedTimer);
      this.reducedTimer = 0;
    }
    this.traceActive = false;
    this.traceEntries = [];
  }

  private animateTrace = (now: number) => {
    if (this.destroyed) {
      return;
    }
    this.traceNow = now;
    const elapsed = now - this.traceStart;
    this.draw();
    if (elapsed < this.traceTotal + 600) {
      this.frame = requestAnimationFrame(this.animateTrace);
      return;
    }
    this.traceActive = false;
    this.traceEntries = [];
    this.frame = 0;
    this.draw();
    this.onTraceEnd?.();
  };

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const backingWidth = Math.round(width * this.dpr);
    const backingHeight = Math.round(height * this.dpr);
    if (
      this.width === width &&
      this.height === height &&
      this.canvas.width === backingWidth &&
      this.canvas.height === backingHeight
    ) {
      return;
    }
    this.width = width;
    this.height = height;
    this.canvas.width = backingWidth;
    this.canvas.height = backingHeight;
    if (this.autoFit) {
      this.fit();
    } else {
      this.draw();
    }
  }

  private bounds() {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of this.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + this.nodeWidth);
      maxY = Math.max(maxY, node.y + this.nodeHeight(node));
    }
    if (!Number.isFinite(minX)) {
      return { minX: 0, minY: 0, width: 1, height: 1 };
    }
    return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  private nodeHeight(node: FlowNode) {
    const rows = this.compact ? Math.min(node.rows.length, 1) : node.rows.length;
    return this.headerHeight + this.padY * 2 + rows * this.rowHeight;
  }

  private rowCenter(node: FlowNode, row: number) {
    const rows = this.compact ? Math.min(node.rows.length, 1) : node.rows.length;
    const clamped = clamp(row, 0, Math.max(0, rows - 1));
    return node.y + this.headerHeight + this.padY + clamped * this.rowHeight + this.rowHeight / 2;
  }

  private portOffset(node: FlowNode, row: number) {
    const rows = this.compact ? 1 : node.rows.length;
    const mid = (rows - 1) / 2;
    const offset = (clamp(row, 0, rows - 1) - mid) * 18;
    return clamp(offset, -this.nodeWidth / 2 + 18, this.nodeWidth / 2 - 18);
  }

  private portPoint(node: FlowNode, port: FlowPort, side: Side): Point {
    if (side === "left") {
      return { x: node.x, y: this.rowCenter(node, port.row) };
    }
    if (side === "right") {
      return { x: node.x + this.nodeWidth, y: this.rowCenter(node, port.row) };
    }
    const x = node.x + this.nodeWidth / 2 + this.portOffset(node, port.row);
    if (side === "top") {
      return { x, y: node.y };
    }
    return { x, y: node.y + this.nodeHeight(node) };
  }

  private linkSides(link: FlowLink): { from: Side; to: Side } | null {
    const from = this.nodes.find((node) => node.id === link.from);
    const to = this.nodes.find((node) => node.id === link.to);
    if (!from || !to) {
      return null;
    }
    if (this.portSides === "horizontal") {
      return { from: "right", to: "left" };
    }
    const dx = to.x + this.nodeWidth / 2 - (from.x + this.nodeWidth / 2);
    const dy = to.y + this.nodeHeight(to) / 2 - (from.y + this.nodeHeight(from) / 2);
    if (Math.abs(dx) < this.nodeWidth * 0.75 && Math.abs(dy) > 40) {
      return dy > 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
    }
    return { from: "right", to: "left" };
  }

  private control(point: Point, side: Side, distance: number): Point {
    if (side === "left") {
      return { x: point.x - distance, y: point.y };
    }
    if (side === "right") {
      return { x: point.x + distance, y: point.y };
    }
    if (side === "top") {
      return { x: point.x, y: point.y - distance };
    }
    return { x: point.x, y: point.y + distance };
  }

  private linkPoints(link: FlowLink): LinkPoints | null {
    const sides = this.linkSides(link);
    const from = this.nodes.find((node) => node.id === link.from);
    const to = this.nodes.find((node) => node.id === link.to);
    if (!sides || !from || !to) {
      return null;
    }
    const fromPort = from.outputs?.[link.fromPort] ?? { name: "out", row: 0 };
    const toPort = to.inputs?.[link.toPort] ?? { name: "in", row: 0 };
    const start = this.portPoint(from, fromPort, sides.from);
    const end = this.portPoint(to, toPort, sides.to);
    const distance = clamp(
      Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) * 0.45,
      30,
      140,
    );
    return {
      start,
      control1: this.control(start, sides.from, distance),
      control2: this.control(end, sides.to, distance),
      end,
    };
  }

  private traceProgress(link: FlowLink) {
    if (!this.traceActive) {
      return 0;
    }
    const entry = this.traceEntries.find((candidate) => candidate.link === link);
    if (!entry) {
      return 0;
    }
    return clamp((this.traceNow - this.traceStart - entry.start) / entry.duration, 0, 1);
  }

  private draw() {
    if (this.destroyed) {
      return;
    }
    const { ctx, width, height, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, width, height);
    this.drawGrid();
    ctx.save();
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.scale, this.transform.scale);
    for (const link of this.links) {
      this.drawLink(link);
    }
    this.drawTrace();
    for (const node of this.nodes) {
      this.drawNode(node);
    }
    ctx.restore();
    this.drawLinkLabels();
  }

  private drawGrid() {
    const { ctx, width, height } = this;
    const scale = this.transform.scale;
    if (this.theme.gridStyle === "dots") {
      const spacing = 24 * scale;
      const offsetX = ((this.transform.x % spacing) + spacing) % spacing;
      const offsetY = ((this.transform.y % spacing) + spacing) % spacing;
      ctx.fillStyle = this.theme.grid;
      for (let x = offsetX; x < width; x += spacing) {
        for (let y = offsetY; y < height; y += spacing) {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return;
    }
    const spacing = 32 * scale;
    const offsetX = ((this.transform.x % spacing) + spacing) % spacing;
    const offsetY = ((this.transform.y % spacing) + spacing) % spacing;
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = offsetX; x < width; x += spacing) {
      const px = Math.round(x) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
    }
    for (let y = offsetY; y < height; y += spacing) {
      const py = Math.round(y) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(width, py);
    }
    ctx.stroke();
  }

  private drawLink(link: FlowLink) {
    const points = this.linkPoints(link);
    if (!points) {
      return;
    }
    const { ctx } = this;
    const progress = this.traceProgress(link);
    const connected = this.selected === link.from || this.selected === link.to;
    const active = progress > 0 || connected;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points.start.x, points.start.y);
    ctx.bezierCurveTo(
      points.control1.x,
      points.control1.y,
      points.control2.x,
      points.control2.y,
      points.end.x,
      points.end.y,
    );
    ctx.strokeStyle = active ? this.theme.linkActive : this.theme.link;
    ctx.lineWidth = (active ? 2 : 1.25) / this.transform.scale;
    ctx.setLineDash(link.dashed ? [5 / this.transform.scale, 4 / this.transform.scale] : []);
    ctx.stroke();
    ctx.restore();
  }

  private drawTrace() {
    const { ctx } = this;
    for (const entry of this.traceEntries) {
      const progress = this.traceProgress(entry.link);
      if (progress <= 0 || progress >= 1) {
        continue;
      }
      const points = this.linkPoints(entry.link);
      if (!points) {
        continue;
      }
      const point = bezierPoint(points, easeOutCubic(progress));
      ctx.beginPath();
      ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = this.theme.linkActive;
      ctx.fill();
      ctx.lineWidth = 1.5 / this.transform.scale;
      ctx.strokeStyle = this.theme.background;
      ctx.stroke();
    }
  }

  private inputSide(node: FlowNode, portIndex: number): Side {
    for (const link of this.links) {
      if (link.to !== node.id || link.toPort !== portIndex) {
        continue;
      }
      const sides = this.linkSides(link);
      if (sides) {
        return sides.to;
      }
    }
    return "left";
  }

  private outputSide(node: FlowNode, portIndex: number): Side {
    for (const link of this.links) {
      if (link.from !== node.id || link.fromPort !== portIndex) {
        continue;
      }
      const sides = this.linkSides(link);
      if (sides) {
        return sides.from;
      }
    }
    return "right";
  }

  private drawNode(node: FlowNode) {
    const { ctx } = this;
    const width = this.nodeWidth;
    const height = this.nodeHeight(node);
    const selected = this.selected === node.id;
    const hovered = this.hovered === node.id;
    const connected = this.isNeighbor(node.id);
    const dim = this.dimOnSelect && this.selected !== null && !selected && !connected;
    ctx.save();
    if (dim) {
      ctx.globalAlpha = 0.5;
    }
    if (this.theme.shadow) {
      ctx.shadowColor = this.theme.shadow;
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 7;
    }
    roundedRect(ctx, node.x, node.y, width, height, 4);
    ctx.fillStyle = this.theme.nodeFill;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 1 / this.transform.scale;
    ctx.strokeStyle = selected || hovered ? this.theme.nodeBorderSelected : this.theme.nodeBorder;
    ctx.stroke();

    topRoundedRect(ctx, node.x, node.y, width, this.headerHeight, 4);
    ctx.fillStyle = this.nodeColors[node.kind];
    ctx.fill();

    const titleX = node.x + (this.numbered && node.number ? 30 : 10);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = `600 ${this.compact ? 10 : 12}px "Alan Sans", sans-serif`;
    ctx.fillStyle = this.nodeText[node.kind];
    ctx.fillText(node.title, titleX, node.y + this.headerHeight / 2 + 0.5);

    ctx.font = `400 ${this.compact ? 7 : 9}px "MonoMMM", monospace`;
    ctx.globalAlpha = dim ? 0.5 : 0.72;
    ctx.textAlign = "right";
    ctx.fillStyle = this.nodeText[node.kind];
    ctx.fillText(
      kindLabels[node.kind].toUpperCase(),
      node.x + width - 9,
      node.y + this.headerHeight / 2 + 0.5,
    );
    ctx.globalAlpha = dim ? 0.5 : 1;

    if (this.numbered && node.number) {
      const cx = node.x + 15;
      const cy = node.y + this.headerHeight / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fillStyle = this.badgeFill;
      ctx.fill();
      ctx.font = '600 9px "MonoMMM", monospace';
      ctx.fillStyle = this.badgeText;
      ctx.textAlign = "center";
      ctx.fillText(String(node.number), cx, cy + 0.5);
      ctx.textAlign = "left";
    }

    const rows = this.compact ? node.rows.slice(0, 1) : node.rows;
    rows.forEach((row, index) => {
      const top = node.y + this.headerHeight + this.padY + index * this.rowHeight;
      if (index > 0) {
        ctx.beginPath();
        ctx.moveTo(node.x + 8, top);
        ctx.lineTo(node.x + width - 8, top);
        ctx.strokeStyle = this.theme.rowLine;
        ctx.lineWidth = 1 / this.transform.scale;
        ctx.stroke();
      }
      ctx.font = `400 ${this.compact ? 8 : 10}px "MonoMMM", monospace`;
      ctx.fillStyle = this.theme.label;
      ctx.textAlign = "left";
      ctx.fillText(row.label, node.x + 10, top + this.rowHeight / 2 + 0.5);
      ctx.font = `400 ${this.compact ? 9 : 11}px "MonoMMM", monospace`;
      ctx.fillStyle = this.theme.value;
      ctx.textAlign = "right";
      ctx.fillText(row.value, node.x + width - 10, top + this.rowHeight / 2 + 0.5);
    });

    const inputs = this.compact ? node.inputs?.slice(0, 1) : node.inputs;
    const outputs = this.compact ? node.outputs?.slice(0, 1) : node.outputs;
    for (const [index, port] of (inputs ?? []).entries()) {
      const side = this.inputSide(node, index);
      const point = this.portPoint(node, port, side);
      this.drawPort(point, this.nodeColors[node.kind], selected);
    }
    for (const [index, port] of (outputs ?? []).entries()) {
      const side = this.outputSide(node, index);
      const point = this.portPoint(node, port, side);
      this.drawPort(point, this.nodeColors[node.kind], selected);
    }

    if (selected) {
      roundedRect(ctx, node.x - 2, node.y - 2, width + 4, height + 4, 6);
      ctx.strokeStyle = this.theme.nodeBorderSelected;
      ctx.lineWidth = 1.5 / this.transform.scale;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPort(point: Point, color: string, selected: boolean) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(point.x, point.y, selected ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = this.theme.portFill;
    ctx.fill();
    ctx.lineWidth = 1.5 / this.transform.scale;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  private isNeighbor(id: string) {
    if (this.selected === null) {
      return false;
    }
    return this.links.some(
      (link) =>
        (link.from === this.selected && link.to === id) ||
        (link.to === this.selected && link.from === id),
    );
  }

  private drawLinkLabels() {
    if (!this.linkLabels || this.transform.scale < 0.45) {
      return;
    }
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const link of this.links) {
      if (!link.label) {
        continue;
      }
      const points = this.linkPoints(link);
      if (!points) {
        continue;
      }
      const midpoint = bezierPoint(points, 0.5);
      const x = midpoint.x * this.transform.scale + this.transform.x;
      const y = midpoint.y * this.transform.scale + this.transform.y;
      if (x < -80 || x > this.width + 80 || y < -20 || y > this.height + 20) {
        continue;
      }
      ctx.font = '400 9px "MonoMMM", monospace';
      const textWidth = ctx.measureText(link.label).width;
      const width = textWidth + 10;
      const height = 14;
      const connected = this.selected === link.from || this.selected === link.to;
      const active = connected || this.traceProgress(link) > 0;
      roundedRect(ctx, x - width / 2, y - height / 2, width, height, 3);
      ctx.fillStyle = this.theme.linkLabelBg;
      ctx.fill();
      ctx.fillStyle = active ? this.theme.linkActive : this.theme.linkLabel;
      ctx.fillText(link.label, x, y + 0.5);
    }
  }

  private toGraph(event: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - this.transform.x) / this.transform.scale,
      y: (event.clientY - rect.top - this.transform.y) / this.transform.scale,
    };
  }

  private hitTest(point: Point): FlowNode | null {
    for (let index = this.nodes.length - 1; index >= 0; index--) {
      const node = this.nodes[index];
      if (
        point.x >= node.x &&
        point.x <= node.x + this.nodeWidth &&
        point.y >= node.y &&
        point.y <= node.y + this.nodeHeight(node)
      ) {
        return node;
      }
    }
    return null;
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    const point = this.toGraph(event);
    const node = this.hitTest(point);
    this.pointerStart = { x: event.clientX, y: event.clientY };
    this.moved = false;
    if (!this.interactive) {
      this.select(node?.id ?? null);
      return;
    }
    if (node) {
      this.select(node.id);
      this.drag = {
        type: "node",
        id: node.id,
        offsetX: point.x - node.x,
        offsetY: point.y - node.y,
      };
    } else {
      this.drag = {
        type: "pan",
        startX: event.clientX,
        startY: event.clientY,
        tx: this.transform.x,
        ty: this.transform.y,
      };
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private handlePointerMove = (event: PointerEvent) => {
    if (this.drag && this.pointerStart) {
      const dx = event.clientX - this.pointerStart.x;
      const dy = event.clientY - this.pointerStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        this.moved = true;
      }
      if (this.drag.type === "node") {
        const drag = this.drag;
        const node = this.nodes.find((entry) => entry.id === drag.id);
        if (node) {
          const point = this.toGraph(event);
          node.x = point.x - drag.offsetX;
          node.y = point.y - drag.offsetY;
          this.autoFit = false;
          this.draw();
        }
        return;
      }
      this.transform.x = this.drag.tx + dx;
      this.transform.y = this.drag.ty + dy;
      this.autoFit = false;
      this.draw();
      return;
    }
    const node = this.hitTest(this.toGraph(event));
    this.canvas.style.cursor = node ? (this.interactive ? "grab" : "pointer") : "default";
    if (this.hovered !== (node?.id ?? null)) {
      this.highlight(node?.id ?? null);
    }
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (this.drag?.type === "pan" && !this.moved) {
      this.select(null);
    }
    this.drag = null;
    this.pointerStart = null;
    this.canvas.style.cursor = this.hovered ? (this.interactive ? "grab" : "pointer") : "default";
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
  };

  private handlePointerLeave = () => {
    if (!this.drag && this.hovered !== null) {
      this.highlight(null);
    }
  };

  private handleWheel = (event: WheelEvent) => {
    if (!this.interactive) {
      return;
    }
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const before = {
      x: (px - this.transform.x) / this.transform.scale,
      y: (py - this.transform.y) / this.transform.scale,
    };
    const scale = clamp(this.transform.scale * Math.exp(-event.deltaY * 0.0015), 0.25, 2.2);
    this.transform.scale = scale;
    this.transform.x = px - before.x * scale;
    this.transform.y = py - before.y * scale;
    this.autoFit = false;
    this.draw();
  };

  private handleDoubleClick = () => {
    if (this.interactive) {
      this.fit();
    }
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "f" || event.key === "F") {
      this.fit();
    }
    if (event.key === "Escape") {
      this.select(null);
    }
  };

  destroy() {
    this.destroyed = true;
    this.cancelTrace();
    this.observer.disconnect();
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);

    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
    this.canvas.removeEventListener("keydown", this.handleKeyDown);
    this.canvas.style.cursor = "";
    this.canvas.style.touchAction = "";
  }
}
