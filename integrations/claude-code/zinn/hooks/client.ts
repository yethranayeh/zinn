// The environment every `zinn` run of this plugin gets, so the CLI records the plugin in its client chain.
import type { EngineInterface } from "claude-code";
import { clientChain, clientToken, type ClientPart } from "../lib/client";

const VERSION = "0.2.0-dev"; // the same as .claude-plugin/plugin.json. The check fails when the two differ

export { VERSION };

/** ZINN_CLIENT: the chain this session inherited, then this part's token. Set over the host's environment. */
export async function zinnEnv(
  $: EngineInterface,
  part: ClientPart,
): Promise<{ ZINN_CLIENT: string }> {
  const inherited = await $.env.get("ZINN_CLIENT").catch(() => undefined);
  return { ZINN_CLIENT: clientChain(inherited, clientToken(part, VERSION)) };
}
