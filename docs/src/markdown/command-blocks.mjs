/**
 * Copies fenced code text, language, and optional title mapped by MDX
 */
export const commandBlocks = {
	name: "command-blocks",
	element: {
		filter: ["pre"],
		visit(node, ctx) {
			const code = node.children.find((child) => child.type === "element" && child.tagName === "code");

			ctx.setProperty(node, "dataCommands", ctx.textContent(code));
			ctx.setProperty(node, "dataLabel", code.data?.meta?.match(/title="([^"]*)"/)?.[1]);

			const classes = code.properties?.className;
			const classNames = Array.isArray(classes) ? classes : typeof classes === "string" ? [classes] : [];
			const languageClass = classNames.find((className) => className.startsWith("language-"));

			ctx.setProperty(node, "dataLanguage", languageClass?.slice("language-".length));
		}
	}
};
