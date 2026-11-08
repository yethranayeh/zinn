import { Schema } from "effect";

/**
 * The settings row's choices.
 * A stored value outside the list falls back to the default.
 * @default 60
 */
export const REFRESH_CHOICES = [30, 60, 300, 900] as const;

export type Settings = {
  summary: boolean;
  refreshSeconds: number;
};

export const DEFAULT_SETTINGS: Settings = {
  summary: true,
  refreshSeconds: REFRESH_CHOICES[1],
};

export const Prefs = Schema.Struct({
  summary: Schema.Boolean,
  refreshSeconds: Schema.Number,
});

export const refreshLabel = (seconds: number) =>
  seconds < 60 ? `${seconds} s` : `${seconds / 60} min`;
