// Sections that show breadcrumbs: the first URL segment maps to the section name.
export const sectionNames: Record<string, string> = {
  docs: "Docs",
  integrations: "Integrations",
};

interface Page {
  id: string;
  data: { title: string; navTitle?: string };
}

export interface BreadcrumbItem {
  name: string;
  path: string;
}

export function getBreadcrumbItems(
  pathname: string,
  title: string | undefined,
  pages: Array<Page>,
): Array<BreadcrumbItem> {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2 || title === undefined) {
    return [];
  }

  const names = new Map(pages.map(({ id, data }) => [id, data.navTitle ?? data.title]));

  return segments.flatMap((_segment, index) => {
    const id = segments.slice(0, index + 1).join("/");
    const isCurrent = index === segments.length - 1;
    const name = isCurrent ? (names.get(id) ?? title) : (names.get(id) ?? sectionNames[id]);
    return name === undefined ? [] : [{ name, path: isCurrent ? pathname : `/${id}/` }];
  });
}
