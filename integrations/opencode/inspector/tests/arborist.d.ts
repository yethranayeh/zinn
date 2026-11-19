declare module "@npmcli/arborist" {
	export interface ArboristNode {
		location: string;
		package?: {
			version?: string;
		};
	}

	export interface ArboristTree {
		inventory: Map<string, ArboristNode>;
	}

	export class Arborist {
		constructor(options: Record<string, unknown>);
		reify(options: Record<string, unknown>): Promise<ArboristTree>;
	}
}
