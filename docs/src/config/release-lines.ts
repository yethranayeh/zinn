/** Integrations released on their own version, keyed by their folder in src/releases. */
export const integrationLines = {
  opencode: { label: "OpenCode", packageName: "opencode" },
} as const;

export type IntegrationLine = keyof typeof integrationLines;
