// The parts of Pagefind's browser API that search uses. The npm package only types its build API.
interface PagefindSection {
  title: string;
  url: string;
  excerpt: string;
  locations: number[];
  anchor?: { id: string };
}

export interface PagefindResult {
  url: string;
  excerpt: string;
  meta: { title: string };
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
