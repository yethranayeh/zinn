// Copies each code block's text and its title="..." fence meta onto the <pre>, for the component MDX maps pre to.
export const commandBlocks = {
	name: "command-blocks",
	element: {
		filter: ["pre"],
		visit(node, ctx) {
			const code = node.children.find((child) => child.type === "element" && child.tagName === "code");
			ctx.setProperty(node, "dataCommands", ctx.textContent(code));
			ctx.setProperty(node, "dataLabel", code.data?.meta?.match(/title="([^"]*)"/)?.[1]);
		}
	}
};
