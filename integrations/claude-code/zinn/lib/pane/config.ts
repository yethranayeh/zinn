// The pane's options. An option left at `from-env` reads its variable, then its default. Pure: the caller
// reads the environment and passes the values.
import { isLayout, type Layout } from "./resolve";

export type Config = { enabled: boolean; layout: Layout; layoutSource: string };
export type EnvReads = { layout?: string | undefined };
export const DEFAULT_LAYOUT: Layout = "table";

export function parseConfig(options: Readonly<Record<string, unknown>>, env: EnvReads): Config {
  const opt =
    typeof options["layout"] === "string" ? options["layout"].trim().toLowerCase() : "from-env";
  const envLayout = (env.layout ?? "").trim().toLowerCase();
  let layout: Layout = DEFAULT_LAYOUT;
  let layoutSource = "default";

  if (isLayout(opt)) {
    layout = opt;
    layoutSource = "option";
  } else if (isLayout(envLayout)) {
    layout = envLayout;
    layoutSource = "env";
  }

  return { enabled: options["pane"] !== false, layout, layoutSource };
}
