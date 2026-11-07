import { FRAME_MS, fit, ink, noise, onResize, reducedMotion } from "./canvas";
import { figures } from "./page-figures";

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bytes: number;
  parts: Array<{ download: number; zinn: boolean }>;
  leaving: boolean;
}

const dropCell = 6;
const simulationStepsPerFrame = 7;
const simulationDt = 1 / 60;
const pull = 26;
const damping = 0.965;
const leavingAcceleration = 1.03;
const minimumSpeed = 1.5;
/** Frames after a split before drops may run back together */
const separatedFrames = 12;
/** The largest drop's radius as a fraction of the canvas's shorter side */
const radiusFactor = 0.22;
/** A smaller drop merges once its center is this fraction of its own radius inside the larger drop */
const mergeFactor = 0.5;

/** Drop homes as canvas fractions, largest package first */
const dropHomes: Record<"net" | "gross", Array<[number, number]>> = {
  gross: [
    [0.3, 0.5],
    [0.68, 0.72],
    [0.68, 0.28],
    [0.88, 0.32],
    [0.88, 0.68],
  ],
  net: [
    [0.36, 0.5],
    [0.64, 0.5],
  ],
};

export function setupDrops(initialMode: "net" | "gross") {
  const button = document.querySelector<HTMLButtonElement>("[data-drops]");
  const canvas = button?.querySelector("canvas");

  if (!button || !canvas) {
    return { setMode: (_mode: "net" | "gross") => {} };
  }

  let mode = initialMode;
  let drops: Drop[] = [];
  let width = 0;
  let height = 0;
  let timer = 0;
  let holdFrames = 0;
  let pointer: { x: number; y: number } | null = null;
  let visible = true;
  let separated = false;

  const scale = () => (Math.min(width, height * 1.6) * radiusFactor) / Math.sqrt(figures.gross);
  const radius = (bytes: number) => Math.sqrt(bytes) * scale();
  const wanted = () => figures.packages.filter((entry) => mode === "gross" || entry.zinn);
  /** The wanted packages, largest download first, which is the order the homes are listed in */
  const ordered = () => [...wanted()].sort((first, second) => second.download - first.download);
  const homePoint = (part: { download: number; zinn: boolean }) => {
    const [x, y] = dropHomes[mode][ordered().indexOf(part)] ?? [0.5, 0.5];
    return { x: x * width, y: y * height };
  };

  function settled() {
    const parts = wanted();
    drops = [
      {
        x: width / 2,
        y: height / 2,
        vx: 0,
        vy: 0,
        bytes: parts.reduce((sum, entry) => sum + entry.download, 0),
        parts,
        leaving: false,
      },
    ];
  }

  function split() {
    const pieces: Drop[] = [];
    for (const drop of drops) {
      drop.parts.forEach((part, index) => {
        const angle =
          (index / drop.parts.length) * Math.PI * 2 + noise(index, drop.bytes % 97) * 1.2;
        const speed = 150 + noise(index, 3) * 120;
        pieces.push({
          x: drop.x,
          y: drop.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          bytes: part.download,
          parts: [part],
          leaving: drop.leaving,
        });
      });
    }
    drops = pieces;
  }

  /** Places every drop at its home with no speed, for a resize or reduced motion */
  function toHomes() {
    for (const drop of drops) {
      const home = homePoint(drop.parts[0]);
      drop.x = home.x;
      drop.y = home.y;
      drop.vx = 0;
      drop.vy = 0;
    }
  }

  function step() {
    const centerX = width / 2;
    const centerY = height / 2;
    let nearest: Drop | null = null;
    let nearestDistance = Infinity;

    if (pointer) {
      for (const drop of drops) {
        if (drop.leaving) {
          continue;
        }
        const distance = Math.hypot(pointer.x - drop.x, pointer.y - drop.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = drop;
        }
      }
    }

    for (const drop of drops) {
      if (!drop.leaving) {
        const target = separated ? homePoint(drop.parts[0]) : { x: centerX, y: centerY };
        const strength = holdFrames > 0 ? pull * 0.05 : pull;
        drop.vx += (target.x - drop.x) * strength * simulationDt;
        drop.vy += (target.y - drop.y) * strength * simulationDt;
      }

      if (pointer && drop === nearest && !drop.leaving) {
        const dx = pointer.x - drop.x;
        const dy = pointer.y - drop.y;
        const distance = Math.max(30, Math.hypot(dx, dy));
        drop.vx += (dx / distance) * 240 * simulationDt;
        drop.vy += (dy / distance) * 240 * simulationDt;
      }

      // Leaving drops keep speeding up until they are off the canvas.
      const friction = drop.leaving ? leavingAcceleration : damping;
      drop.vx *= friction;
      drop.vy *= friction;
      drop.x += drop.vx * simulationDt;
      drop.y += drop.vy * simulationDt;
    }

    drops = drops.filter((drop) => {
      const r = radius(drop.bytes);
      return (
        !drop.leaving || (drop.x > -r && drop.x < width + r && drop.y > -r && drop.y < height + r)
      );
    });

    if (holdFrames > 0 || separated) {
      return;
    }

    // Touching drops become one drop with their combined area
    for (let a = 0; a < drops.length; a++) {
      for (let b = a + 1; b < drops.length; b++) {
        const first = drops[a];
        const second = drops[b];
        if (first.leaving || second.leaving) {
          continue;
        }

        const larger = first.bytes >= second.bytes ? first : second;
        const smaller = larger === first ? second : first;
        const overlap = radius(larger.bytes) - radius(smaller.bytes) * mergeFactor;

        if (Math.hypot(first.x - second.x, first.y - second.y) < overlap) {
          const bytes = first.bytes + second.bytes;
          first.x = (first.x * first.bytes + second.x * second.bytes) / bytes;
          first.y = (first.y * first.bytes + second.y * second.bytes) / bytes;
          first.vx = (first.vx * first.bytes + second.vx * second.bytes) / bytes;
          first.vy = (first.vy * first.bytes + second.vy * second.bytes) / bytes;
          first.bytes = bytes;
          first.parts = [...first.parts, ...second.parts];
          drops.splice(b, 1);
          return;
        }
      }
    }
  }

  function draw() {
    const { context } = fit(canvas!);
    context.clearRect(0, 0, width, height);

    const rendered = drops.map((drop) => ({ drop, r: radius(drop.bytes) }));
    context.fillStyle = ink.soot;

    for (let y = dropCell / 2; y < height; y += dropCell) {
      for (let x = dropCell / 2; x < width; x += dropCell) {
        let field = 0;
        let nearest: { drop: Drop; r: number } | null = null;
        let strongest = 0;

        for (const item of rendered) {
          const squared = (x - item.drop.x) ** 2 + (y - item.drop.y) ** 2;
          const value = (item.r * item.r) / Math.max(squared, 0.01);
          field += value;
          if (value > strongest) {
            strongest = value;
            nearest = item;
          }
        }

        if (field < 1 || !nearest) {
          continue;
        }
        // Shade like a sphere lit from the upper left: bigger dots on the shadow side, in five levels.
        const normalX = (x - nearest.drop.x) / nearest.r;
        const normalY = (y - nearest.drop.y) / nearest.r;
        const depth = Math.sqrt(Math.max(0, 1 - normalX * normalX - normalY * normalY));
        const light = Math.max(0, normalX * -0.5 + normalY * -0.6 + depth * 0.62);
        const level = Math.min(4, Math.max(0, Math.floor((1 - light) * 5)));
        const dot = 0.7 + level * 0.46;
        context.beginPath();
        context.arc(x, y, dot, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  function resting() {
    const moving = drops.some((drop) => Math.hypot(drop.vx, drop.vy) > minimumSpeed);
    if (separated) {
      return !pointer && !moving;
    }

    const target = wanted().length;
    const parts = drops.filter((drop) => !drop.leaving);

    return (
      !pointer &&
      holdFrames === 0 &&
      !moving &&
      parts.length === 1 &&
      parts[0].parts.length === target &&
      drops.length === 1
    );
  }

  function frame() {
    for (let index = 0; index < simulationStepsPerFrame; index++) {
      step();
    }

    if (holdFrames > 0) {
      holdFrames -= 1;
    }

    draw();

    if (resting()) {
      stop();
    }
  }

  function stop() {
    window.clearInterval(timer);
    timer = 0;
  }

  function start() {
    if (reducedMotion) {
      if (separated) {
        toHomes();
      } else {
        settled();
      }
      draw();
      return;
    }

    if (!timer && visible) {
      timer = window.setInterval(frame, FRAME_MS);
    }
  }

  function setMode(next: "net" | "gross") {
    mode = next;
    separated = false;
    button!.setAttribute("aria-pressed", "false");
    split();
    holdFrames = separatedFrames;

    const keep = wanted();
    const present = new Set(drops.flatMap((drop) => drop.parts));

    keep
      .filter((part) => !present.has(part))
      .forEach((part, index) => {
        // Packages joining the download fall in from above, one after another
        drops.push({
          x: width * (0.2 + noise(index, 7) * 0.6),
          y: -radius(part.download) - index * 60,
          vx: 0,
          vy: 120,
          bytes: part.download,
          parts: [part],
          leaving: false,
        });
      });
    for (const drop of drops) {
      drop.leaving = !keep.includes(drop.parts[0]);
    }
    start();
  }

  button.addEventListener("click", () => {
    if (separated) {
      separated = false;
      button.setAttribute("aria-pressed", "false");
      start();
      return;
    }

    split();
    // A click springs the drops to their homes, so the split impulse would only throw the small ones off the canvas
    for (const drop of drops) {
      if (!drop.leaving) {
        drop.vx = 0;
        drop.vy = 0;
      }
    }

    separated = true;
    button.setAttribute("aria-pressed", "true");

    if (reducedMotion) {
      toHomes();
      draw();
      return;
    }

    start();
  });

  button.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") {
      return;
    }
    const box = canvas.getBoundingClientRect();
    pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
    start();
  });

  button.addEventListener("pointerleave", () => {
    pointer = null;
    start();
  });

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (!visible) {
      stop();
    } else {
      start();
    }
  }).observe(button);

  onResize(button, () => {
    const box = canvas.getBoundingClientRect();
    width = box.width;
    height = box.height;
    if (separated) {
      toHomes();
    } else {
      settled();
    }
    draw();
  });

  return { setMode };
}
