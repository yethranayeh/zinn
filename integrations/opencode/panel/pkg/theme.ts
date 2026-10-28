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
// Alpha suffixes for tinted backgrounds: about 10% at rest and 20% when active.
export const TINT_ALPHA_SUBTLE = "1a";
export const TINT_ALPHA_STRONG = "33";

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

export function toneColor(ctx: Ctx, tone: () => RowTone): () => RGBA {
  const theme = () => panelTheme(ctx);
  return () => {
    const value = tone();
    if (value === "warning" || value === "blocked") {
      return theme().warning;
    }
    if (value === "created") {
      return theme().info;
    }
    if (value === "done") {
      return theme().success;
    }
    return theme().text;
  };
}
