import type { Ctx, Mention, TaskSummary } from "./types.ts";

import { openPicker } from "./dialogs.tsx";
import { mentionCounts } from "./scan.ts";

export type PanelSnapshot = {
  map: Map<string, TaskSummary> | undefined;
  known: readonly Mention[];
};

export let activePanel: PanelSnapshot | undefined;
export function publishPanel(snapshot: PanelSnapshot): void {
  activePanel = snapshot;
}
export function clearPanel(snapshot: PanelSnapshot | undefined): void {
  if (snapshot !== undefined && activePanel === snapshot) {
    activePanel = undefined;
  }
}
export function registerCommands(ctx: Ctx): void {
  const commands: unknown[] = [
    {
      id: "zinn.chat",
      name: "zinn.chat",
      title: "Zinn: task keys in this chat",
      description: "Pick a task mentioned in this conversation",
      desc: "Pick a task mentioned in this conversation",
      group: "Zinn",
      category: "Zinn",
      palette: true,
      namespace: "palette",
      run() {
        const panel = activePanel;
        if (!panel) {
          ctx.ui.toast.show({
            variant: "warning",
            title: "Zinn",
            message: "no session panel mounted",
          });
          return;
        }
        const keys = panel.known.map((mention) => mention.key);
        openPicker(
          ctx,
          "Zinn | keys in this chat",
          keys,
          panel.map,
          false,
          mentionCounts(panel.known),
        );
      },
    },
    {
      id: "zinn.board",
      name: "zinn.board",
      title: "Zinn: pick a task from the board",
      description: "Search every task in the store",
      desc: "Search every task in the store",
      group: "Zinn",
      category: "Zinn",
      palette: true,
      namespace: "palette",
      slash: { name: "zinn" },
      slashName: "zinn",
      run() {
        const panel = activePanel;
        if (!panel?.map) {
          ctx.ui.toast.show({
            variant: "warning",
            title: "Zinn",
            message: "Open a session to load tasks.",
          });
          return;
        }
        const map = panel.map;
        openPicker(
          ctx,
          "Zinn | all tasks",
          [...map.keys()],
          map,
          false,
          mentionCounts(panel.known),
        );
      },
    },
  ];

  ctx.keymap.layer((() => ({ mode: "global", priority: 350, commands })) as () => never);
}
