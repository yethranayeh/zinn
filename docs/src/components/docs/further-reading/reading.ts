import type { Sentence } from "./model";

// The reading band runs from the text's visible top to this fraction of the viewport height
const readingBandBottom = 0.6;
// The sentences being read are worked out once scrolling has paused this long, in milliseconds
const scrollSettleDelay = 150;

/** A vertical stretch of the viewport, in pixels. */
export type Band = { top: number; bottom: number };

/** Where the text shows from, below the sticky header and breadcrumb rail. */
function visibleTextTop() {
  return document.querySelector("[data-reading-rail]")?.getBoundingClientRect().bottom ?? 0;
}

/** The reading band. At the end of the page it reaches the bottom, since the text there cannot scroll up into it. */
function readingBand(): Band {
  const isAtPageEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 1;

  return {
    top: visibleTextTop(),
    bottom: isAtPageEnd ? innerHeight : innerHeight * readingBandBottom,
  };
}

/** The sentences that overlap the band, in page order. */
function sentencesInBand(sentences: Array<Sentence>, { top, bottom }: Band) {
  return sentences.filter(({ range }) => {
    const box = range.getBoundingClientRect();
    return box.height > 0 && box.bottom > top && box.top < bottom;
  });
}

/**
 * Calls back with the sentences in the reading band at once and again whenever scrolling or resizing settles.
 */
export function followReading(
  sentences: Array<Sentence>,
  onSettle: (current: Array<Sentence>, band: Band) => void,
) {
  let timer: number | undefined;

  function report() {
    const band = readingBand();
    onSettle(sentencesInBand(sentences, band), band);
  }

  function settle() {
    window.clearTimeout(timer);
    timer = window.setTimeout(report, scrollSettleDelay);
  }

  window.addEventListener("scroll", settle, { passive: true });
  window.addEventListener("resize", settle, { passive: true });
  report();
}
