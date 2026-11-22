import type { Row, Sentence } from "./model";

// One row per step while an arrow is hovered, as Base UI's Select scroll arrows step
const arrowStepDelay = 40;
// Pixels of slack when comparing a row's edges with the window's, for fractional layout
const edgeTolerance = 1;

/** Why the window held still or moved, and the rows (as indexes) the decision was about. */
export type Decision = {
  outcome: "none" | "pointer" | "same" | "inside" | "moved" | "asked";
  rows: Array<number>;
  /** The sentence a bracket's number was clicked for. */
  number?: number;
};

export type RowItem = { row: Row; item: HTMLLIElement; anchor: HTMLAnchorElement };

type Elements = {
  section: HTMLElement;
  list: HTMLUListElement;
  up: HTMLElement;
  down: HTMLElement;
  template: HTMLTemplateElement;
};

function rowItem(template: HTMLTemplateElement, row: Row): RowItem {
  const item = template.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const anchor = item.querySelector("a")!;
  const { link, sentence } = row;

  anchor.href = link.url;
  item.querySelector("[data-further-reading-number]")!.textContent = String(sentence.number);
  item.querySelector("[data-further-reading-heading]")!.textContent =
    link.heading || link.pageTitle;

  if (link.heading !== "" && link.heading !== link.pageTitle) {
    item.querySelector("[data-further-reading-page]")!.textContent = link.pageTitle;
  }

  return { row, item, anchor };
}

/**
 * Fills the list with a row per destination and runs its three-row window.
 * The window holds still while the rows of the sentences being read are inside it and moves at once when they are not.
 */
export function createRowList({ section, list, up, down, template }: Elements, rows: Array<Row>) {
  const items = rows.map((row) => rowItem(template, row));
  let arrowTimer: number | undefined;
  let followedKeys = "";

  list.replaceChildren(...items.map(({ item }) => item));

  function indexesOf(sentence: Sentence) {
    return items.flatMap(({ row }, index) => (row.sentence === sentence ? [index] : []));
  }

  function updateArrows() {
    up.toggleAttribute("data-visible", list.scrollTop > edgeTolerance);
    down.toggleAttribute(
      "data-visible",
      list.scrollTop < list.scrollHeight - list.clientHeight - edgeTolerance,
    );
  }

  function firstVisibleIndex() {
    const index = items.findIndex(
      ({ item }) => item.offsetTop + item.offsetHeight / 2 > list.scrollTop,
    );
    return Math.max(0, index);
  }

  function scrollToIndex(index: number) {
    list.scrollTop = items[Math.max(0, Math.min(index, items.length - 1))].item.offsetTop;
    updateArrows();
  }

  function isInWindow(indexes: Array<number>) {
    const top = list.scrollTop;
    const bottom = top + list.clientHeight;
    const first = items[indexes[0]].item;
    const last = items[indexes.at(-1)!].item;
    return (
      first.offsetTop >= top - edgeTolerance &&
      last.offsetTop + last.offsetHeight <= bottom + edgeTolerance
    );
  }

  // Hovering an arrow steps one row at a time until the pointer leaves or the end is reached
  function stepWhileHovered(arrow: HTMLElement, step: 1 | -1) {
    function tick() {
      const before = list.scrollTop;
      scrollToIndex(firstVisibleIndex() + step);

      if (list.scrollTop !== before && arrow.hasAttribute("data-visible")) {
        arrowTimer = window.setTimeout(tick, arrowStepDelay);
      }
    }

    arrow.addEventListener("mouseenter", () => {
      window.clearTimeout(arrowTimer);
      arrowTimer = window.setTimeout(tick, arrowStepDelay);
    });
    arrow.addEventListener("mouseleave", () => window.clearTimeout(arrowTimer));
  }

  stepWhileHovered(up, -1);
  stepWhileHovered(down, 1);
  list.addEventListener("scroll", updateArrows, { passive: true });
  new ResizeObserver(updateArrows).observe(list);

  /** Brings the rows into the window when they are not all inside it. */
  function reveal(indexes: Array<number>, number: number): Decision {
    if (!isInWindow(indexes)) {
      scrollToIndex(indexes[0]);
    }

    return { outcome: "asked", rows: indexes, number };
  }

  /** Marks the rows of the sentences being read as current, then places the window. */
  function follow(current: Array<Sentence>): Decision {
    const keys = new Set(current.map(({ key }) => key));
    const currentIndexes: Array<number> = [];

    items.forEach(({ row, anchor }, index) => {
      const isCurrent = keys.has(row.sentence.key);
      anchor.toggleAttribute("data-current", isCurrent);

      if (isCurrent) {
        currentIndexes.push(index);
      }
    });

    const nextKeys = [...keys].join("\n");
    const hasChanged = nextKeys !== followedKeys;
    followedKeys = nextKeys;

    if (currentIndexes.length === 0) {
      return { outcome: "none", rows: [] };
    }

    // The window holds still while the reader points at the list, and for sentences it already placed
    if (section.matches(":hover")) {
      return { outcome: "pointer", rows: currentIndexes };
    }

    if (!hasChanged) {
      return { outcome: "same", rows: currentIndexes };
    }

    if (isInWindow(currentIndexes)) {
      return { outcome: "inside", rows: currentIndexes };
    }

    scrollToIndex(currentIndexes[0]);
    return { outcome: "moved", rows: currentIndexes };
  }

  return { items, indexesOf, reveal, follow };
}
