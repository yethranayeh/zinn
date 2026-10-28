import type { RGBA } from "@opentui/core";
import type { RowTone } from "./rows.ts";
import type { Ctx } from "./types.ts";

export type PanelTheme = {
  text: RGBA;
  textMuted: RGBA;
  error: RGBA;
  warning: RGBA;
  success: RGBA;
  info: RGBA;
  borderSubtle: RGBA;
  backgroundElement: RGBA;
  accent: RGBA;
};

// Read theme values inside a reactive computation so theme changes repaint.
export function panelTheme(ctx: Ctx): PanelTheme {
  const t = ctx.theme;
  return {
    text: t.text.base,
    textMuted: t.text.muted,
    error: t.text.feedback.error.base,
    warning: t.text.feedback.warning.base,
    success: t.text.feedback.success.base,
    info: t.text.feedback.info.base,
    borderSubtle: t.border.base,
    backgroundElement: t.background.raised.high,
    accent: t.text.action.primary.base,
  };
}

export function toneColor(ctx: Ctx, tone: RowTone): () => RGBA {
  const theme = () => panelTheme(ctx);
  if (tone === "warning") {
    return () => theme().warning;
  }
  if (tone === "blocked") {
    return () => theme().warning;
  }
  if (tone === "created") {
    return () => theme().info;
  }
  if (tone === "done") {
    return () => theme().success;
  }
  return () => theme().text;
}
