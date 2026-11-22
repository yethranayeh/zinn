import type { SuggestedLink } from "steerdown/browser";
import { loadPage, originRange, readSentences } from "steerdown/browser";

/** A sentence that links grow out of, numbered once in page order. The key is stable while the page is open. */
export type Sentence = { key: string; number: number; range: Range; links: Array<SuggestedLink> };

/** One destination, kept at the sentence that suggests it most strongly. */
export type Row = { link: SuggestedLink; sentence: Sentence };

/** The numbered sentences in page order, and the rows in the order of their sentences. */
export type Model = { sentences: Array<Sentence>; rows: Array<Row> };

type Candidate = { key: string; range: Range; link: SuggestedLink };

/**
 * Every section's links, each destination kept once at the sentence where it is most probable.
 * On a tie the earlier sentence keeps it. A sentence left without links gets no number.
 */
export async function buildModel(): Promise<Model> {
  const page = await loadPage();
  const anchors = [...new Set((await readSentences()).map(({ anchor }) => anchor))];
  const strongest = new Map<string, Candidate>();

  for (const anchor of anchors) {
    for (const link of page.links(anchor)) {
      const range = await originRange(anchor, link);

      if (link.origin === undefined || range === undefined) {
        continue;
      }

      const kept = strongest.get(link.url);
      const isStronger = kept === undefined || link.probability > kept.link.probability;
      const isEarlierTie =
        kept !== undefined &&
        link.probability === kept.link.probability &&
        range.compareBoundaryPoints(Range.START_TO_START, kept.range) < 0;

      if (isStronger || isEarlierTie) {
        strongest.set(link.url, {
          key: `${anchor} ${link.origin.position} ${link.origin.hash}`,
          range,
          link,
        });
      }
    }
  }

  const byKey = new Map<string, Sentence>();

  for (const { key, range, link } of strongest.values()) {
    const sentence = byKey.get(key) ?? { key, number: 0, range, links: [] };
    sentence.links.push(link);
    byKey.set(key, sentence);
  }

  const sentences = [...byKey.values()].sort((first, second) =>
    first.range.compareBoundaryPoints(Range.START_TO_START, second.range),
  );
  const rows: Array<Row> = [];

  sentences.forEach((sentence, index) => {
    sentence.number = index + 1;
    sentence.links.sort((first, second) => second.probability - first.probability);

    for (const link of sentence.links) {
      rows.push({ link, sentence });
    }
  });

  return { sentences, rows };
}
