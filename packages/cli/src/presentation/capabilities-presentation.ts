import type { getCapabilitySummary } from "../capabilities.js";

export function formatCapabilities(summary: ReturnType<typeof getCapabilitySummary>): string {
  return `${summary.cli.name} ${summary.cli.version} (Experimental): ${summary.commandCount} commands, manifest format ${summary.manifestVersion}.\nRun zinn capabilities --json for the full contract.`;
}
