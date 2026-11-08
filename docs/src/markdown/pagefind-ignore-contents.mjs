/**
 * Keeps a page's table of contents out of the search index.
 * The Contents list repeats every heading, so it would outrank the sections it links to.
 * Matches the heading text because heading ids are assigned after this plugin runs.
 * Pagefind cannot parse sibling combinators, so a selector in pagefind.yml cannot reach the list.
 */
export const pagefindIgnoreContents = {
	name: "pagefind-ignore-contents",
	element: {
		filter: ["h2"],
		visit(node, ctx) {
			if (ctx.textContent(node).trim() !== "Contents") {
				return;
			}
			ctx.setProperty(node, "dataPagefindIgnore", "index");

			const siblings = ctx.parent(node)?.children ?? [];
			const list = siblings.slice(ctx.indexOf(node) + 1).find((sibling) => sibling.type === "element");

			if (list?.tagName === "ul") {
				ctx.setProperty(list, "dataPagefindIgnore", "index");
			}
		}
	}
};
