export type ScreenshotAppearance = "dark" | "light";

export interface ScreenshotScene {
  id: string;
  label: string;
  images: Partial<Record<ScreenshotAppearance, string>>;
}
