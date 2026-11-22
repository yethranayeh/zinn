import type { Decision } from "./list";
import type { Sentence } from "./model";
import type { Band } from "./reading";

const highlightName = "further-reading-debug";

// The sentences in the band get a wavy underline, which no utility class can style
const highlightStyles = new CSSStyleSheet();
highlightStyles.replaceSync(
  `::highlight(${highlightName}) { text-decoration: underline wavy var(--color-cinnabar); text-decoration-thickness: 1px; }`,
);

function rowRange(rows: Array<number>) {
  const first = rows[0] + 1;
  const last = rows.at(-1)! + 1;
  return first === last ? `row ${first}` : `rows ${first}–${last}`;
}

/** What the window did with the last reading, in words. */
function describe({ outcome, rows, number }: Decision) {
  switch (outcome) {
    case "none":
      return "no rows: nothing in the band has a link, window held";
    case "pointer":
      return `${rowRange(rows)} current, held: pointer on the list`;
    case "same":
      return `${rowRange(rows)} current, held: same sentences as before`;
    case "inside":
      return `${rowRange(rows)} current, held: all in the window`;
    case "moved":
      return `${rowRange(rows)} current, moved to row ${rows[0] + 1}: the first current row`;
    case "asked":
      return `sentence ${number} asked for ${rowRange(rows)}`;
  }
}

function overlay(className: string) {
  const node = document.createElement("div");
  node.className = className;
  node.hidden = true;
  document.body.append(node);
  return node;
}

/**
 * The debug view of further reading: the reading band's edges across the page, the sentences inside the band,
 * and a readout of the band, those sentences and what the window decided. The toggle in the section shows and hides it.
 */
export function createDebugView(root: HTMLElement) {
  const toggle = root.querySelector<HTMLButtonElement>("[data-further-reading-debug]")!;
  const lineClasses =
    "pointer-events-none fixed inset-x-0 z-40 border-t border-dashed border-cinnabar";
  const topEdge = overlay(lineClasses);
  const bottomEdge = overlay(lineClasses);
  const readout = overlay(
    "pointer-events-none fixed bottom-4 left-4 z-40 max-w-[calc(100vw-2rem)] bg-cinnabar px-2 py-1 font-mono text-[11px] text-limestone",
  );
  let isOn = false;
  let reading: { band: Band; current: Array<Sentence> } | undefined;
  let note = "";

  function draw() {
    const hasReading = isOn && reading !== undefined;
    topEdge.hidden = !hasReading;
    bottomEdge.hidden = !hasReading;
    readout.hidden = !isOn || (reading === undefined && note === "");

    if (!hasReading) {
      CSS.highlights.delete(highlightName);
    }

    if (!isOn) {
      return;
    }

    const parts = [note];

    if (reading !== undefined) {
      const { band, current } = reading;
      topEdge.style.top = `${band.top}px`;
      bottomEdge.style.top = `${band.bottom}px`;

      if (current.length > 0) {
        CSS.highlights.set(highlightName, new Highlight(...current.map(({ range }) => range)));
      } else {
        CSS.highlights.delete(highlightName);
      }

      const numbers =
        current.length === 0 ? "none" : current.map((sentence) => sentence.number).join(", ");
      parts.unshift(
        `band ${Math.round(band.top)}–${Math.round(band.bottom)}px`,
        `reading ${numbers}`,
      );
    }

    readout.textContent = parts.filter(Boolean).join("  ·  ");
  }

  document.adoptedStyleSheets.push(highlightStyles);
  toggle.addEventListener("click", () => {
    isOn = !isOn;
    toggle.setAttribute("aria-pressed", String(isOn));
    draw();
  });

  return {
    /** The reading band and the sentences in it, with what the window did about them. */
    settle(band: Band, current: Array<Sentence>, decision: Decision) {
      reading = { band, current };
      note = describe(decision);
      draw();
    },
    /** What the window did without a new reading. */
    decided(decision: Decision) {
      note = describe(decision);
      draw();
    },
  };
}

export type DebugView = ReturnType<typeof createDebugView>;
