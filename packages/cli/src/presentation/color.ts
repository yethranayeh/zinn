import { styleText } from "node:util";

type StyleFormat = Parameters<typeof styleText>[0];

/**
 * Bun's styleText emits ANSI even when stdout is piped or NO_COLOR is set, so Zinn decides when to color.
 * FORCE_COLOR (https://force-color.org/) wins over NO_COLOR and the TTY check.
 * Following https://no-color.org/, any NO_COLOR value turns color off.
 */
export function isColorEnabled() {
  const forceColor = process.env.FORCE_COLOR ?? "";
  const isForceColorSet = forceColor.length > 0;

  if (isForceColorSet) {
    return forceColor !== "0";
  }

  const isNoColorSet = (process.env.NO_COLOR ?? "").length > 0;

  return process.stdout.isTTY === true && !isNoColorSet;
}

export function styleOutputText(format: StyleFormat, text: string) {
  if (!isColorEnabled()) {
    return text;
  }

  return styleText(format, text);
}
