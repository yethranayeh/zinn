// The client chain a `zinn` run declares in ZINN_CLIENT (https://zinn.sh/docs/core#client-chain-convention)

/** A part of this plugin that runs the CLI. */
export type ClientPart = "mentions" | "pane" | "claims";

export function clientToken(part: ClientPart, version: string): string {
  return `zinn-claude-code:${part}/${version}`;
}

/**
 * The inherited chain, trimmed, then the token, one space between.
 * A blank inherited chain leaves the token.
 */
export function clientChain(inherited: string | null | undefined, token: string): string {
  const kept = inherited?.trim() ?? "";
  return kept === "" ? token : `${kept} ${token}`;
}
