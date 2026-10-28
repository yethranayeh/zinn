/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";

import { registerCommands } from "./commands.ts";
import { errorText, log } from "./data.ts";
import { readOptions } from "./options.ts";
import { Sidebar } from "./sidebar.tsx";

const tui = Plugin.define({
  id: "zinn.tasks",
  setup(ctx) {
    const settings = readOptions(ctx.options);
    log(ctx, "plugin options", {
      rows: settings.rows,
      raw: ctx.options === undefined ? null : "present",
    });
    registerCommands(ctx);
    try {
      log(ctx, "keymap commands", { ids: ctx.keymap.commands().map((c) => c.id) });
    } catch (error) {
      log(ctx, "keymap commands failed", { error: errorText(error) });
    }
    const dispose = ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <Sidebar ctx={ctx} sessionID={input.sessionID} options={settings} />,
    });
    return () => {
      dispose();
    };
  },
});
export default tui;
