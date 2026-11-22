import { expect, test } from "bun:test";
import type { InspectorOptions } from "./options.ts";
import type {
  SettingsController,
  SettingsMenuHost,
  StoredSettings,
} from "./settings.ts";

import {
  RESET_CHOICE,
  SETTING_CURRENT,
  SETTING_RENEW_CLAIMS,
  SETTING_ROWS,
  applySetting,
  effectiveOptions,
  hasStoredSettings,
  nextChoice,
  resetStoredSettings,
  runSettingsMenu,
  settingsOptions,
} from "./settings.ts";

const defaults: InspectorOptions = { rows: 1, current: "off", renewClaims: true };

function controller(over: Partial<SettingsController> = {}): SettingsController {
  return {
    options: () => defaults,
    hasOverrides: () => false,
    apply: async () => {},
    reset: async () => {},
    ...over,
  };
}

function menuHost(
  select: SettingsMenuHost["ui"]["dialog"]["select"],
  toasts: string[] = [],
): SettingsMenuHost {
  return {
    ui: {
      dialog: { select },
      toast: { show: (options) => toasts.push(options.message) },
    },
  };
}

test("follows the config file when the store is empty", () => {
  expect(effectiveOptions(undefined, {})).toEqual(defaults);
  expect(effectiveOptions({ rows: 2, current: "glyph", renewClaims: false }, {})).toEqual({
    rows: 2,
    current: "glyph",
    renewClaims: false,
  });
});

test("stored choices override the same keys in the config file", () => {
  const options = effectiveOptions(
    { rows: 2, current: "glyph", renewClaims: false },
    { rows: 1, renewClaims: true },
  );
  expect(options).toEqual({ rows: 1, current: "glyph", renewClaims: true });
});

test("invalid stored values fall back to the config file", () => {
  const stored = { rows: 3, current: "on", renewClaims: "no" } as unknown as StoredSettings;
  expect(effectiveOptions({ rows: 2, current: "glyph" }, stored)).toEqual({
    rows: 2,
    current: "glyph",
    renewClaims: true,
  });
});

test("reports stored settings only when a value is usable", () => {
  expect(hasStoredSettings({})).toBe(false);
  expect(hasStoredSettings({ rows: 3 } as unknown as StoredSettings)).toBe(false);
  expect(hasStoredSettings({ current: "glyph" })).toBe(true);
  expect(hasStoredSettings({ renewClaims: false })).toBe(true);
});

test("shows one row per setting with its current value", () => {
  const choices = settingsOptions({ rows: 2, current: "glyph", renewClaims: false }, false);
  expect(choices).toEqual([
    { title: "Sidepanel rows", value: SETTING_ROWS, description: "2 rows" },
    { title: "Conversation mark", value: SETTING_CURRENT, description: "glyph" },
    { title: "Renew claims", value: SETTING_RENEW_CLAIMS, description: "off" },
  ]);
  expect(settingsOptions(defaults, false).map((choice) => choice.description)).toEqual([
    "1 row",
    "off",
    "on",
  ]);
});

test("cycles each setting to its other value", () => {
  expect(nextChoice(SETTING_ROWS, { ...defaults, rows: 1 })).toBe("rows:2");
  expect(nextChoice(SETTING_ROWS, { ...defaults, rows: 2 })).toBe("rows:1");
  expect(nextChoice(SETTING_CURRENT, { ...defaults, current: "off" })).toBe("current:glyph");
  expect(nextChoice(SETTING_CURRENT, { ...defaults, current: "glyph" })).toBe("current:off");
  expect(nextChoice(SETTING_RENEW_CLAIMS, { ...defaults, renewClaims: true })).toBe("renewClaims:off");
  expect(nextChoice(SETTING_RENEW_CLAIMS, { ...defaults, renewClaims: false })).toBe("renewClaims:on");
  expect(nextChoice(RESET_CHOICE, defaults)).toBeUndefined();
  expect(nextChoice("unknown", defaults)).toBeUndefined();
});

test("offers reset only while the store has overrides", () => {
  const choices = settingsOptions(defaults, true);
  const reset = choices.find((choice) => choice.value === RESET_CHOICE);
  expect(reset?.value).toBe(RESET_CHOICE);
  expect(choices[choices.length - 1]?.value).toBe(RESET_CHOICE);
});

test("applies each value and ignores an unknown choice", () => {
  const stored: StoredSettings = {};
  applySetting(stored, "rows:2");
  expect(stored.rows).toBe(2);
  applySetting(stored, "current:glyph");
  expect(stored.current).toBe("glyph");
  applySetting(stored, "renewClaims:off");
  expect(stored.renewClaims).toBe(false);
  applySetting(stored, "renewClaims:on");
  expect(stored.renewClaims).toBe(true);
  applySetting(stored, "unknown");
  expect(stored).toEqual({ rows: 2, current: "glyph", renewClaims: true });
});

test("clears every stored value on reset", () => {
  const stored: StoredSettings = { rows: 2, current: "glyph", renewClaims: false };
  resetStoredSettings(stored);
  expect(stored).toEqual({});
});

test("the menu cycles a setting and reopens with the new value", async () => {
  const picks = [SETTING_ROWS, undefined];
  const seen: string[][] = [];
  const applied: string[] = [];
  let current = defaults;
  const host = menuHost(async (options) => {
    seen.push(options.options.map((choice) => `${choice.title}: ${choice.description}`));
    return picks.shift();
  });
  await runSettingsMenu(
    host,
    controller({
      options: () => current,
      apply: async (choice) => {
        applied.push(choice);
        current = { ...current, rows: 2 };
      },
    }),
  );
  expect(applied).toEqual(["rows:2"]);
  expect(seen).toHaveLength(2);
  expect(seen[1]).toContain("Sidepanel rows: 2 rows");
});

test("the menu resets and closes on escape", async () => {
  const picks = [RESET_CHOICE, undefined];
  let resets = 0;
  const host = menuHost(async () => picks.shift());
  await runSettingsMenu(
    host,
    controller({
      hasOverrides: () => true,
      reset: async () => {
        resets += 1;
      },
    }),
  );
  expect(resets).toBe(1);
});

test("a failed write reports the error and closes the menu", async () => {
  const toasts: string[] = [];
  const picks = [SETTING_ROWS, undefined];
  const host = menuHost(async () => picks.shift(), toasts);
  await runSettingsMenu(
    host,
    controller({
      apply: async () => {
        throw new Error("disk full");
      },
    }),
  );
  expect(toasts).toEqual(["disk full"]);
  expect(picks).toHaveLength(1);
});
