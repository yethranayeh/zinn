/** @jsxImportSource @opentui/solid */
import type { SettingsController, StoredSettings } from "./settings.ts";

import { Plugin } from "@opencode/plugin/tui";

import { registerCommands } from "./commands.ts";
import { errorText, log } from "./data.ts";
import {
  SETTINGS_STORE_KEY,
  applySetting,
  effectiveOptions,
  hasStoredSettings,
  resetStoredSettings,
} from "./settings.ts";
import { Sidebar } from "./sidebar.tsx";

const tui = Plugin.define({
  id: "zinn.tasks",
  setup(ctx) {
    const [stored, updateStored] = ctx.storage.store<StoredSettings>(SETTINGS_STORE_KEY, {
      initial: {},
    });
    const options = () => effectiveOptions(ctx.options, stored);
    const settings: SettingsController = {
      options,
      hasOverrides: () => hasStoredSettings(stored),
      async apply(choice) {
        await updateStored((draft) => {
          applySetting(draft, choice);
        });
        const next = options();
        log(ctx, "setting changed", {
          choice,
          rows: next.rows,
          current: next.current,
          renewClaims: next.renewClaims,
        });
      },
      async reset() {
        await updateStored((draft) => {
          resetStoredSettings(draft);
        });
        const next = options();
        log(ctx, "settings reset", {
          rows: next.rows,
          current: next.current,
          renewClaims: next.renewClaims,
        });
      },
    };
    log(ctx, "plugin options", {
      rows: options().rows,
      overrides: hasStoredSettings(stored),
      raw: ctx.options === undefined ? null : "present",
    });
    registerCommands(ctx, settings);
    try {
      log(ctx, "keymap commands", { ids: ctx.keymap.commands().map((c) => c.id) });
    } catch (error) {
      log(ctx, "keymap commands failed", { error: errorText(error) });
    }
    const dispose = ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <Sidebar ctx={ctx} sessionID={input.sessionID} options={options()} />,
    });
    return () => {
      dispose();
    };
  },
});
export default tui;
