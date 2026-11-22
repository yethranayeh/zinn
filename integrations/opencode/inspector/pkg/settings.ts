import type { CurrentMark, InspectorOptions } from "./options.ts";

import { errorText, isRecord } from "./data.ts";
import { readOptions } from "./options.ts";

export const SETTINGS_STORE_KEY = "settings";
export const SETTINGS_TITLE = "Zinn | settings";
export const SETTING_ROWS = "rows";
export const SETTING_CURRENT = "current";
export const SETTING_RENEW_CLAIMS = "renewClaims";
export const RESET_CHOICE = "reset";
const ROWS_ONE = "rows:1";
const ROWS_TWO = "rows:2";
const CURRENT_OFF = "current:off";
const CURRENT_GLYPH = "current:glyph";
const RENEW_ON = "renewClaims:on";
const RENEW_OFF = "renewClaims:off";
export type StoredSettings = {
  rows?: 1 | 2;
  current?: CurrentMark;
  renewClaims?: boolean;
};
export type SettingChoice = {
  title: string;
  value: string;
  description: string;
};
export type SettingsController = {
  options: () => InspectorOptions;
  hasOverrides: () => boolean;
  apply: (choice: string) => Promise<void>;
  reset: () => Promise<void>;
};
export type SettingsMenuHost = {
  ui: {
    dialog: {
      select: (options: {
        title: string;
        placeholder?: string;
        options: readonly SettingChoice[];
      }) => Promise<string | undefined>;
    };
    toast: {
      show: (options: { variant: "error"; title: string; message: string }) => void;
    };
  };
};
/** Keeps only values the options understand, so a stale store falls back to the config file. */
export function cleanStoredSettings(stored: StoredSettings): StoredSettings {
  const clean: StoredSettings = {};
  if (stored.rows === 1 || stored.rows === 2) {
    clean.rows = stored.rows;
  }
  if (stored.current === "off" || stored.current === "glyph") {
    clean.current = stored.current;
  }
  if (typeof stored.renewClaims === "boolean") {
    clean.renewClaims = stored.renewClaims;
  }
  return clean;
}
/** Stored choices win over the same keys in `cli.json`. Untouched keys still follow the file. */
export function effectiveOptions(config: unknown, stored: StoredSettings): InspectorOptions {
  const base = isRecord(config) ? config : {};
  return readOptions({ ...base, ...cleanStoredSettings(stored) });
}
export function hasStoredSettings(stored: StoredSettings): boolean {
  return Object.keys(cleanStoredSettings(stored)).length > 0;
}
export function settingsOptions(
  options: InspectorOptions,
  overridden: boolean,
): SettingChoice[] {
  const choices: SettingChoice[] = [
    {
      title: "Sidepanel rows",
      value: SETTING_ROWS,
      description: options.rows === 1 ? "1 row" : "2 rows",
    },
    {
      title: "Conversation mark",
      value: SETTING_CURRENT,
      description: options.current,
    },
    {
      title: "Renew claims",
      value: SETTING_RENEW_CLAIMS,
      description: options.renewClaims ? "on" : "off",
    },
  ];
  if (overridden) {
    choices.push({
      title: "Reset to cli.json",
      value: RESET_CHOICE,
      description: "Clears the values set here, so the file applies again.",
    });
  }
  return choices;
}
/** The other value for a binary setting, as an internal choice. */
export function nextChoice(setting: string, current: InspectorOptions): string | undefined {
  switch (setting) {
    case SETTING_ROWS:
      return current.rows === 1 ? ROWS_TWO : ROWS_ONE;
    case SETTING_CURRENT:
      return current.current === "off" ? CURRENT_GLYPH : CURRENT_OFF;
    case SETTING_RENEW_CLAIMS:
      return current.renewClaims ? RENEW_OFF : RENEW_ON;
    default:
      return undefined;
  }
}
export function applySetting(stored: StoredSettings, choice: string): void {
  switch (choice) {
    case ROWS_ONE:
      stored.rows = 1;
      break;
    case ROWS_TWO:
      stored.rows = 2;
      break;
    case CURRENT_OFF:
      stored.current = "off";
      break;
    case CURRENT_GLYPH:
      stored.current = "glyph";
      break;
    case RENEW_ON:
      stored.renewClaims = true;
      break;
    case RENEW_OFF:
      stored.renewClaims = false;
      break;
    default:
      break;
  }
}
export function resetStoredSettings(stored: StoredSettings): void {
  delete stored.rows;
  delete stored.current;
  delete stored.renewClaims;
}
/** Changes one setting per visit and reopens with the new value shown. */
export async function runSettingsMenu(
  host: SettingsMenuHost,
  controller: SettingsController,
): Promise<void> {
  for (;;) {
    const current = controller.options();
    const choices = settingsOptions(current, controller.hasOverrides());
    let picked: string | undefined;
    try {
      picked = await host.ui.dialog.select({
        title: SETTINGS_TITLE,
        placeholder: "change a setting",
        options: choices,
      });
      if (picked === undefined) {
        return;
      }
      if (picked === RESET_CHOICE) {
        await controller.reset();
      } else {
        const choice = nextChoice(picked, current);
        if (choice === undefined) {
          return;
        }
        await controller.apply(choice);
      }
    } catch (error) {
      host.ui.toast.show({
        variant: "error",
        title: "Zinn",
        message: errorText(error),
      });
      return;
    }
  }
}
