import type { Sentence } from "./model";

// Text rectangles whose tops sit within this many pixels of a line's bottom belong to that line
const lineOverlapTolerance = 2;
// Brackets closer than this many pixels vertically share a lane
const bracketGap = 2;
// Horizontal room between overlapping brackets in the gutter, in pixels
const laneWidth = 10;
// How far the nearest lane sits to the left of the article's text
const firstLaneOffset = "1.25rem";

/** A sentence's line as vertical extents relative to the bracket layer. */
type Line = { top: number; bottom: number };

/** The sentence's lines relative to the bracket layer, with pieces on one line merged. */
function lineBoxes(range: Range, layerTop: number) {
  const rects = [...range.getClientRects()]
    .filter(({ height, width }) => height > 0 && width > 0)
    .sort((first, second) => first.top - second.top);
  const lines: Array<Line> = [];

  for (const rect of rects) {
    const box = { top: rect.top - layerTop, bottom: rect.bottom - layerTop };
    const last = lines.at(-1);

    if (last !== undefined && box.top < last.bottom - lineOverlapTolerance) {
      last.bottom = Math.max(last.bottom, box.bottom);
    } else {
      lines.push(box);
    }
  }

  return lines;
}

/**
 * Draws a bracket per sentence in the article's gutter, copied from the template, and returns them by sentence key.
 * Brackets that share vertical space move to further lanes.
 */
export function drawBrackets(
  layer: HTMLElement,
  template: HTMLTemplateElement,
  sentences: Array<Sentence>,
) {
  const layerTop = layer.getBoundingClientRect().top;
  const laneBottoms: Array<number> = [];
  const brackets = new Map<string, HTMLElement>();

  for (const sentence of sentences) {
    const lines = lineBoxes(sentence.range, layerTop);

    if (lines.length === 0) {
      continue;
    }

    const top = lines[0].top;
    const bottom = lines.at(-1)!.bottom;
    let lane = laneBottoms.findIndex((laneBottom) => laneBottom < top - bracketGap);

    if (lane === -1) {
      lane = laneBottoms.length;
    }

    laneBottoms[lane] = bottom;

    const bracket = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
    const number = bracket.querySelector("button")!;

    console.log("step 1");
    number.textContent = String(sentence.number);
    console.log("success");
    number.setAttribute("aria-label", `Show further reading for sentence ${sentence.number}`);
    bracket.style.top = `${top}px`;
    bracket.style.height = `${bottom - top}px`;
    bracket.style.left = `calc(-${firstLaneOffset} - ${lane * laneWidth}px)`;
    brackets.set(sentence.key, bracket);
  }

  layer.replaceChildren(...brackets.values());
  return brackets;
}
