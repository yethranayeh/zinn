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

const SECONDS_PER_MINUTE = 60;

export const refreshLabel = (seconds: number) => {
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds} seconds`;
  }

  const minutes = seconds / SECONDS_PER_MINUTE;

  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
};
