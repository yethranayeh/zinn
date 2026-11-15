/** WCAG 2 contrast maths and the palette reader for Foundry. */

export type ContrastLevel = "AAA" | "AA" | "AA large" | "Fail";

export const thresholds = {
  normalAA: 4.5,
  normalAAA: 7,
  largeAA: 3,
} as const;

/** Reads `--color-<name>: #rrggbb` declarations from the theme stylesheet. */
export function paletteFrom(css: string): Record<string, string> {
  return Object.fromEntries(
    [...css.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6});/g)].map(([, name, hex]) => [
      name,
      hex.toLowerCase(),
    ]),
  );
}

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, blue] = (hex.replace("#", "").match(/../g) ?? []).map((part) =>
      parseInt(part, 16),
    );
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(blue);
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

export function levelOf(ratio: number): ContrastLevel {
  if (ratio >= thresholds.normalAAA) {
    return "AAA";
  }
  if (ratio >= thresholds.normalAA) {
    return "AA";
  }
  if (ratio >= thresholds.largeAA) {
    return "AA large";
  }
  return "Fail";
}
