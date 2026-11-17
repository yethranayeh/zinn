/**
 * The zinn plugin:
 *  Zinn task keys in the Claude Code transcript (./mentions.tsx)
 *  and the Zinn pane (./pane.tsx)
 *
 * One module for both, so they share one key map, one mark table and one footer word
 */
import type { Register } from "claude-code";

import { registerMentions, startMentions } from "./mentions";
import { registerPane, startPane } from "./pane";

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 160);

export const register: Register = (on, options) => {
  registerPane(on, options);
  registerMentions(on, options);
  //
  //

  /**
   * The engine takes one unmatched session.start hook per module.
   * A part that fails to start leaves the other running, as two separate hooks would.
   * The pane goes first: it only registers its command.
   */

  on("session.start", async ($, e, next) => {
    try {
      await startPane(options, $, e);
    } catch (err) {
      $.ui.log(`zinn: pane start failed: ${errText(err)}`);
    }

    try {
      await startMentions(options, $, e);
    } catch (err) {
      $.ui.log(`zinn: start failed: ${errText(err)}`);
    }

    return next(e);
  });
};
