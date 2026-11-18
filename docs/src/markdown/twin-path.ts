// The Markdown twin of a site page: /docs/cli/ serves /docs/cli.md, and the homepage /index.md.
export function markdownTwinPath(pathname: string) {
  const page = pathname.replace(/\/$/, "");
  if (page === "") {
    return "/index.md";
  }

  return `${page}.md`;
}
