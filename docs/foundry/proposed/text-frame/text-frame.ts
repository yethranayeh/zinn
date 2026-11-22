/** Room between a passage and its frame, in pixels. */
const framePadding = 3;
/** Length of each arm of a corner bracket, in pixels. */
const cornerArm = 5;
/** Rects whose tops differ by less than this belong to the same line, in pixels. */
const sameLineTolerance = 2;

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The passage's lines as boxes relative to the root, with the pieces of one line merged. */
function lineBoxes(passage: HTMLElement, root: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(passage);
  const origin = root.getBoundingClientRect();
  const rects = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.top - b.top);
  const lines: Array<Box> = [];

  for (const rect of rects) {
    const box = {
      top: rect.top - origin.top,
      bottom: rect.bottom - origin.top,
      left: rect.left - origin.left,
      right: rect.right - origin.left,
    };
    const last = lines.at(-1);
    if (last !== undefined && box.top < last.bottom - sameLineTolerance) {
      last.top = Math.min(last.top, box.top);
      last.bottom = Math.max(last.bottom, box.bottom);
      last.left = Math.min(last.left, box.left);
      last.right = Math.max(last.right, box.right);
    } else {
      lines.push(box);
    }
  }
  return lines;
}

/** An L-shaped bracket whose corner is at (x, y) and whose arms run toward (dx, dy). */
function corner(x: number, y: number, dx: number, dy: number): string {
  return `M${x + dx * cornerArm},${y}H${x}V${y + dy * cornerArm}`;
}

/** Corner brackets at the four defining corners, and a contour through the midpoints between lines when there are several. */
function outline(lines: Array<Box>): { corners: string; contour: string } {
  const count = lines.length;
  const first = lines[0];
  const last = lines[count - 1];
  const left = (line: Box) => line.left - framePadding;
  const right = (line: Box) => line.right + framePadding;
  const tops = lines.map((line, index) =>
    index === 0 ? line.top - framePadding : (lines[index - 1].bottom + line.top) / 2,
  );
  const bottoms = lines.map((line, index) =>
    index === count - 1 ? line.bottom + framePadding : (line.bottom + lines[index + 1].top) / 2,
  );

  const corners =
    corner(left(first), tops[0], 1, 1) +
    corner(right(first), tops[0], -1, 1) +
    corner(right(last), bottoms[count - 1], -1, -1) +
    corner(left(last), bottoms[count - 1], 1, -1);

  if (count === 1) {
    return { corners, contour: "" };
  }

  // Down the right edges, then up the left edges
  const points: Array<[number, number]> = [[left(first), tops[0]]];
  lines.forEach((line, index) =>
    points.push([right(line), tops[index]], [right(line), bottoms[index]]),
  );

  for (let index = count - 1; index >= 0; index--) {
    points.push([left(lines[index]), bottoms[index]], [left(lines[index]), tops[index]]);
  }

  return { corners, contour: `M${points.map(([x, y]) => `${x},${y}`).join("L")}Z` };
}

/** Redraws every frame of a root from the current position of its passages. */
export function layoutTextFrame(root: HTMLElement): void {
  for (const passage of root.querySelectorAll<HTMLElement>("[data-text-frame-passage]")) {
    const frame = root.querySelector(
      `[data-text-frame-frame="${passage.dataset.textFramePassage}"]`,
    );
    const lines = lineBoxes(passage, root);

    if (!frame || lines.length === 0) {
      continue;
    }

    const { corners, contour } = outline(lines);
    frame.querySelector("[data-text-frame-corners]")?.setAttribute("d", corners);
    frame.querySelector("[data-text-frame-contour]")?.setAttribute("d", contour);
  }
}

/** Highlights a frame while its passage or one of its controls is hovered or focused. */
export function wireTextFrame(root: HTMLElement) {
  const wire = (target: Element, id: string) => {
    const frame = root.querySelector(`[data-text-frame-frame="${id}"]`);
    const set = (isActive: boolean) => frame?.toggleAttribute("data-active", isActive);

    for (const show of ["mouseenter", "focus"]) {
      target.addEventListener(show, () => set(true));
    }

    for (const hide of ["mouseleave", "blur"]) {
      target.addEventListener(hide, () => set(false));
    }
  };

  for (const passage of root.querySelectorAll<HTMLElement>("[data-text-frame-passage]")) {
    wire(passage, passage.dataset.textFramePassage!);
  }

  for (const control of root.querySelectorAll<HTMLElement>("[data-text-frame-control]")) {
    wire(control, control.dataset.textFrameControl!);
  }
}

/** Draws and wires every text frame under a node, and redraws them when their size changes. */
export function initTextFrames(scope: ParentNode) {
  for (const root of scope.querySelectorAll<HTMLElement>("[data-text-frame]")) {
    layoutTextFrame(root);
    if (root.dataset.textFrameInteractive !== undefined) {
      wireTextFrame(root);
    }

    new ResizeObserver(() => layoutTextFrame(root)).observe(root);
    void document.fonts.ready.then(() => layoutTextFrame(root));
  }
}
