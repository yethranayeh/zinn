/**
 * Integrations released on their own version, keyed by their folder in src/releases. A line is published on
 *  npm under `@zinn-dev/<npm>`, or from GitHub, where `github` is its folder in the repository.
 */
export const integrationLines = {
  opencode: { label: "OpenCode", npm: "opencode" },
  "claude-code": { label: "Claude Code", github: "integrations/claude-code" },
  codex: { label: "Codex", github: "plugins" },
  rex: { label: "Rex", github: "integrations/rex" },
} as const;

export type IntegrationLine = keyof typeof integrationLines;
