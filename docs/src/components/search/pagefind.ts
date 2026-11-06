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

let loaded: Promise<Pagefind> | undefined;

/** Pagefind's files come from the build, so this rejects `astro dev` */
export function loadPagefind(): Promise<Pagefind> {
  loaded ??= window.importPagefind().then(async (pagefind) => {
    await pagefind.init();
    return pagefind;
  });

  return loaded;
}

/** The sections with the most matches, while leaving out page's own heading */
export function sectionsToShow(page: PagefindResult): PagefindSection[] {
  return page.sub_results
    .filter((section) => section.anchor && section.title !== page.meta.title)
    .sort((a, b) => b.locations.length - a.locations.length)
    .slice(0, maxSectionsPerPage);
}
