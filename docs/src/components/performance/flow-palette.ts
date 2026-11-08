export type NodeKind =
	| "agent"
	| "runtime"
	| "cli"
	| "core"
	| "sqlite"
	| "disk"
	| "output"
	| "context"
	| "registry"
	| "npm"
	| "bin"
	| "wal"
	| "cache";

/** Header colours for the flow canvas. The canvas resolves these at mount. */
export const kindColors: Record<NodeKind, string> = {
	agent: "var(--perf-kind-agent)",
	runtime: "var(--perf-kind-runtime)",
	cli: "var(--perf-kind-cli)",
	core: "var(--perf-kind-core)",
	sqlite: "var(--perf-kind-sqlite)",
	disk: "var(--perf-kind-disk)",
	output: "var(--perf-kind-output)",
	context: "var(--perf-kind-context)",
	registry: "var(--perf-kind-registry)",
	npm: "var(--perf-kind-npm)",
	bin: "var(--perf-kind-bin)",
	wal: "var(--perf-kind-wal)",
	cache: "var(--perf-kind-cache)"
};

export const kindText: Record<NodeKind, string> = {
	agent: "var(--color-soot)",
	runtime: "var(--color-limestone)",
	cli: "var(--color-limestone)",
	core: "var(--color-limestone)",
	sqlite: "var(--color-limestone)",
	disk: "var(--color-limestone)",
	output: "var(--color-limestone)",
	context: "var(--color-limestone)",
	registry: "var(--color-limestone)",
	npm: "var(--color-soot)",
	bin: "var(--color-limestone)",
	wal: "var(--color-limestone)",
	cache: "var(--color-limestone)"
};

export const kindLabels: Record<NodeKind, string> = {
	agent: "Agent",
	runtime: "Runtime",
	cli: "CLI",
	core: "Core",
	sqlite: "SQLite",
	disk: "Disk",
	output: "Output",
	context: "Context",
	registry: "Registry",
	npm: "npm",
	bin: "Bin",
	wal: "WAL",
	cache: "Cache"
};
