import type { SettingsController } from "./settings.ts";
import type { SessionSnapshot } from "./session-snapshot.ts";
import type { Ctx, Mention, TaskSummary } from "./types.ts";

import { openPicker } from "./dialogs.tsx";
import { log } from "./data.ts";
import { mentionCounts } from "./scan.ts";
import { loadSessionSnapshot, sessionSnapshotSource } from "./session-snapshot.ts";
import { runSettingsMenu } from "./settings.ts";

export type PanelSnapshot = {
  map: Map<string, TaskSummary> | undefined;
  activeMap: Map<string, TaskSummary> | undefined;
  known: readonly Mention[];
  sessionID: string;
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
export function registerCommands(ctx: Ctx, settings: SettingsController): void {
  const snapshotForCommand = async (): Promise<SessionSnapshot | undefined> => {
    const panel = activePanel;
    if (panel?.activeMap !== undefined) {
      return {
        sessionID: panel.sessionID,
        map: panel.map,
        activeMap: panel.activeMap,
        known: panel.known,
        counts: mentionCounts(panel.known),
      };
    }

    const result = await loadSessionSnapshot(sessionSnapshotSource(ctx));
    if (result.kind === "no-session") {
      ctx.ui.toast.show({
        variant: "warning",
        title: "Zinn",
        message: "Open a session to load tasks.",
      });
      return undefined;
    }
    if (result.kind === "error") {
      ctx.ui.toast.show({
        variant: "warning",
        title: "Zinn",
        message: result.error,
      });
      return undefined;
    }
    return result.snapshot;
  };

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
      async run() {
        const snapshot = await snapshotForCommand();
        if (snapshot === undefined) {
          return;
        }
        openPicker(
          ctx,
          "Zinn | keys in this chat",
          snapshot.known.map((mention) => mention.key),
          snapshot.map,
          false,
          snapshot.counts,
          snapshot.sessionID,
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
      async run() {
        const snapshot = await snapshotForCommand();
        if (snapshot === undefined) {
          return;
        }
        openPicker(
          ctx,
          "Zinn | all tasks",
          [...snapshot.activeMap.keys()],
          snapshot.map,
          false,
          snapshot.counts,
          snapshot.sessionID,
        );
      },
    },
    {
      id: "zinn.settings",
      name: "zinn.settings",
      title: "Zinn: settings",
      description: "Change the sidepanel rows, conversation mark and claim renewal",
      desc: "Change the sidepanel rows, conversation mark and claim renewal",
      group: "Zinn",
      category: "Zinn",
      palette: true,
      namespace: "palette",
      async run() {
        log(ctx, "settings opened");
        await runSettingsMenu(ctx, settings);
      },
    },
  ];

  ctx.keymap.layer((() => ({ mode: "global", priority: 350, commands })) as () => never);
}
