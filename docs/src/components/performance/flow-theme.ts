import type { GraphTheme } from "./graph";

/** Workbench's canvas on the Instrument surface. The canvas resolves these at mount. */
export const hybridTheme: GraphTheme = {
	background: "var(--color-limestone)",
	grid: "color-mix(in srgb, var(--color-soot) 8%, transparent)",
	gridStyle: "dots",
	nodeFill: "var(--perf-node-fill)",
	nodeBorder: "color-mix(in srgb, var(--color-soot) 35%, transparent)",
	nodeBorderSelected: "var(--color-clay)",
	rowLine: "color-mix(in srgb, var(--color-soot) 12%, transparent)",
	label: "var(--color-muted-foreground)",
	value: "var(--color-soot)",
	link: "color-mix(in srgb, var(--color-soot) 35%, transparent)",
	linkActive: "var(--color-clay)",
	linkLabel: "var(--color-muted-foreground)",
	linkLabelBg: "color-mix(in srgb, var(--color-limestone) 92%, transparent)",
	portFill: "var(--perf-node-fill)",
	shadow: "color-mix(in srgb, var(--color-soot) 12%, transparent)"
};
