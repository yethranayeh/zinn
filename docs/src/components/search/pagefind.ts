// The parts of Pagefind's browser API that search uses. The npm package only types its build API.
/** An element with an id, at the word position where its text starts in the page content */
interface PagefindAnchor {
  element: string;
  id: string;
  text: string;
  location: number;
}

interface PagefindSection {
  title: string;
  url: string;
  excerpt: string;
  locations: number[];
  anchor?: PagefindAnchor;
}

export interface PagefindResult {
  url: string;
  content: string;
  excerpt: string;
  meta: { title: string };
  anchors: PagefindAnchor[];
  sub_results: PagefindSection[];
}

interface Pagefind {
  init(): Promise<void>;
  debouncedSearch(
    query: string,
  ): Promise<{ results: { data(): Promise<PagefindResult> }[] } | null>;
}

declare global {
  interface Window {
    importPagefind(): Promise<Pagefind>;
  }
}

const maxSectionsPerPage = 3;

// Queries with more tokens than this never promote a title match, since a title is too short to name them
const maxPromotedTokens = 4;

let loaded: Promise<Pagefind> | undefined;

/** Pagefind's files come from the build, so this rejects `astro dev` */
export function loadPagefind(): Promise<Pagefind> {
  loaded ??= window.importPagefind().then(async (pagefind) => {
    await pagefind.init();
    return pagefind;
  });

  return loaded;
}

/**
 * Words for comparing a query against a title. Punctuation splits, so `--json` becomes `json`,
 *  and a shared trailing `s` is dropped, so `backups` matches `backup`
 */
function nameTokens(text: string) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((token) =>
    token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token,
  );
}

/**
 * Tokens to promote titles on.
 * Empty for wordless queries and for queries too long for a title to name, which leaves the ranking alone
 */
function promotedTokens(query: string): Set<string> {
  const tokens = new Set(nameTokens(query));
  return tokens.size <= maxPromotedTokens ? tokens : new Set();
}

/**
 * - 2: names the query exactly,
 * - 1: contains every query token,
 * - 0: does not match
 */
function titleTier(title: string, query: ReadonlySet<string>) {
  if (query.size === 0) {
    return 0;
  }

  const tokens = new Set(nameTokens(title));
  const contains = tokens.size > 0 && [...query].every((word) => tokens.has(word));

  if (contains) {
    return tokens.size === query.size ? 2 : 1;
  }

  return 0;
}

/** The fields title ranking reads: the page title and its section titles */
interface RankablePage {
  meta: { title: string };
  sub_results: Array<{ title: string }>;
}

/**
 * - 3: names the query in the page title,
 * - 2: in a section title,
 * - 1: contains it anywhere in a title,
 * - 0: names it nowhere
 */
function pageTier(page: RankablePage, query: ReadonlySet<string>) {
  const pageTitle = titleTier(page.meta.title, query);
  if (pageTitle === 2) {
    return 3;
  }

  const sectionTier = page.sub_results.reduce(
    (tier, section) => Math.max(tier, titleTier(section.title, query)),
    0,
  );

  if (sectionTier === 2) {
    return 2;
  }

  return Math.max(pageTitle, sectionTier);
}

/**
 * Loaded results ordered for display so that pages and sections whose titles name the query lead,
 * with Pagefind's own order deciding inside every tier and for everything else.
 */
export function orderResults<P extends RankablePage>(query: string, pages: Array<P>): Array<P> {
  const queryTokens = promotedTokens(query);
  if (queryTokens.size === 0) {
    return pages;
  }

  return pages
    .map((page, index) => ({ page, index, tier: pageTier(page, queryTokens) }))
    .sort((first, second) => second.tier - first.tier || first.index - second.index)
    .map((entry) => entry.page);
}

/** The sections with the most matches, titles naming the query first, while leaving out the page's own heading */
export function sectionsToShow(page: PagefindResult, query: string): Array<PagefindSection> {
  const queryTokens = promotedTokens(query);

  return page.sub_results
    .filter((section) => section.anchor && section.title !== page.meta.title)
    .sort(
      (first, second) =>
        titleTier(second.title, queryTokens) - titleTier(first.title, queryTokens) ||
        second.locations.length - first.locations.length,
    )
    .slice(0, maxSectionsPerPage);
}

const maxDirectiveWords = 8;
const minDirectiveWords = 4;
const maxWordsBeforeMatch = 6;

/** Characters that end or split a text directive, or that mark code and lead-ins */
const directiveBreakers = /[,;&:$-]/;

/** A word that ends a sentence, so the phrase stops after it */
const sentenceEnd = /[.!?]$/;

/** A word that closes a sentence or introduces what follows, so the phrase starts after it */
const clauseBoundary = /[.!?:]$/;

/** A capital usually starts the next sentence or block */
const capitalStart = /^[A-Z]/;

/** The excerpt as text, with the mark elements removed and the marks' text left in place */
function excerptText(excerpt: string) {
  return excerpt.replace(/<[^>]+>/g, "");
}

/**
 * The phrase a text directive points at: the words around the first match, cut before any
 * character the directive syntax reserves and at a sentence end
 */
export function matchedPhrase(excerpt: string): string | null {
  const firstMark = excerpt.indexOf("<mark>");
  if (firstMark < 0) {
    return null;
  }

  // The match position sits in the text with the tags removed, so count the text before it the same way
  const matchAt = excerptText(excerpt.slice(0, firstMark)).length;
  const text = excerptText(excerpt);
  const words = [...text.matchAll(/\S+/g)].map((word) => ({
    text: word[0],
    start: word.index!,
    end: word.index! + word[0].length,
  }));
  const first = words.findIndex((word) => word.end > matchAt);

  if (first < 0 || directiveBreakers.test(words[first]!.text)) {
    return null;
  }

  let last = first;
  if (!sentenceEnd.test(words[first]!.text)) {
    while (last - first + 1 < maxDirectiveWords && last + 1 < words.length) {
      const next = words[last + 1]!;
      if (directiveBreakers.test(next.text) || capitalStart.test(next.text)) {
        break;
      }

      last += 1;
      if (sentenceEnd.test(next.text)) {
        break;
      }
    }
  }

  // Start at the sentence the match sits in, so the phrase reads as a sentence and repeats less
  let start = first;
  for (let step = 0; step < maxWordsBeforeMatch && start > 0; step++) {
    const previous = words[start - 1]!;
    if (directiveBreakers.test(previous.text) || clauseBoundary.test(previous.text)) {
      break;
    }

    start -= 1;
  }

  if (last - start + 1 < minDirectiveWords) {
    return null;
  }

  return text.slice(words[start]!.start, words[last]!.end);
}

const headingElement = /^h[1-6]$/;

/** The number of words in the page content before a character offset */
function wordsBefore(content: string, offset: number) {
  return content.slice(0, offset).match(/\S+/g)?.length ?? 0;
}

/**
 * Whether a browser would mark the phrase inside the section. A text directive marks the first
 * match on the page even when it sits in another section, so the phrase must occur once, in the
 * section's body. A phrase in the heading is refused too, since the indexed heading carries a
 * period the page does not.
 */
function markedInSection(page: PagefindResult, anchor: PagefindAnchor, phrase: string) {
  const at = page.content.indexOf(phrase);
  const occursOnce = at >= 0 && page.content.indexOf(phrase, at + 1) < 0;
  if (!occursOnce) {
    return false;
  }

  const position = wordsBefore(page.content, at);
  const bodyStart = anchor.location + (anchor.text.match(/\S+/g)?.length ?? 0);
  const nextHeading = page.anchors.find(
    (other) => headingElement.test(other.element) && other.location > anchor.location,
  );
  const sectionEnd = nextHeading?.location ?? Number.POSITIVE_INFINITY;

  return position >= bodyStart && position < sectionEnd;
}

/**
 * The section URL with a text directive for the matched phrase, so the destination scrolls to and
 * highlights it. The anchor stays in front of it, so a phrase the page no longer has lands on the section.
 */
export function sectionUrl(page: PagefindResult, section: PagefindSection): string {
  const phrase = matchedPhrase(section.excerpt);
  if (!section.anchor || !phrase || !markedInSection(page, section.anchor, phrase)) {
    return section.url;
  }

  // matchedPhrase refuses dashes, the one directive delimiter encodeURIComponent leaves bare
  return `${section.url}:~:text=${encodeURIComponent(phrase)}`;
}
