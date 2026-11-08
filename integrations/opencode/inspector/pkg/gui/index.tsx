/** @jsxImportSource solid-js */
import type { BoardSummary } from "./ipc.ts";
import type { Settings } from "./prefs.ts";

import { Plugin, SettingsPage, Slot } from "@opencode/plugin/gui";
import { createSignal } from "solid-js";

import { Board } from "./ipc.ts";
import { SettingsView } from "./settings.tsx";
import { BoardStrip } from "./strip.tsx";
import { parseBoard, resolveZinn, runZinn, summarize } from "./zinn.ts";
import { DEFAULT_SETTINGS, Prefs, REFRESH_CHOICES } from "./prefs.ts";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const isRefreshChoice = (value: number): value is (typeof REFRESH_CHOICES)[number] =>
  REFRESH_CHOICES.includes(value as (typeof REFRESH_CHOICES)[number]);

export default Plugin.define({
  setup(ctx) {
    const prefs = ctx.storage.store("prefs", { schema: Prefs, initial: DEFAULT_SETTINGS });
    const [settings, setSettings] = createSignal<Settings>(DEFAULT_SETTINGS);
    const [summary, setSummary] = createSignal<BoardSummary | undefined>();
    const [error, setError] = createSignal("");
    const [directory, setDirectory] = createSignal("");
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let syncTimer: ReturnType<typeof setInterval> | undefined;
    let generation = 0;

    const refresh = async () => {
      if (!settings().summary) {
        return;
      }

      const request = ++generation;
      const target = directory();

      try {
        const raw = await ctx.main(Board).read([target]);
        if (request !== generation) {
          return;
        }

        setSummary(JSON.parse(raw) as BoardSummary);
        setError("");
      } catch (cause) {
        if (request !== generation) {
          return;
        }

        // A failed read is not a reason to show the last counts as current
        setSummary(undefined);
        setError(errorText(cause));
      }
    };

    const armRefresh = () => {
      if (refreshTimer !== undefined) clearInterval(refreshTimer);
      refreshTimer = undefined;
      if (!settings().summary) {
        return;
      }
      refreshTimer = setInterval(() => void refresh(), settings().refreshSeconds * 1_000);
    };

    const update = (patch: Partial<Settings>) => {
      const next = { ...settings(), ...patch };

      setSettings(next);
      prefs.set(next);
      armRefresh();

      void refresh();
    };

    const sync = () => {
      const current = ctx.sessions.current();
      const nextDirectory = current?.directory ?? "";

      if (nextDirectory !== directory()) {
        setDirectory(nextDirectory);
        void refresh();
      }

      const stored = prefs.value;

      if (!stored) {
        return;
      }

      const next = {
        summary: stored.summary !== false,
        refreshSeconds: isRefreshChoice(stored.refreshSeconds)
          ? stored.refreshSeconds
          : DEFAULT_SETTINGS.refreshSeconds,
      };

      if (
        next.summary !== settings().summary ||
        next.refreshSeconds !== settings().refreshSeconds
      ) {
        setSettings(next);
        armRefresh();
        void refresh();
      }
    };

    sync();
    armRefresh();

    syncTimer = setInterval(sync, 1_000);

    if (directory() === "") {
      void refresh();
    }

    const strip: Slot = {
      at: "window.bottom",
      order: -1000,
      render: () => <BoardStrip summary={summary} error={error} />,
    };

    ctx.add(Slot, () => (settings().summary ? strip : undefined));

    ctx.add(SettingsPage, {
      id: "zinn",
      title: "Zinn",
      icon: "outline-console",
      entries: [
        {
          id: "summary",
          title: "Show board summary",
          description: "The task total, per-column counts and last read under the window content.",
          keywords: "strip bar slot bottom hide",
        },
        {
          id: "refresh",
          title: "Refresh the board summary every",
          description: "How often the strip re-reads Zinn.",
          keywords: "interval poll sync",
        },
      ],
      render: () => <SettingsView ui={ctx.ui} settings={settings} update={update} />,
    });

    return () => {
      if (refreshTimer !== undefined) clearInterval(refreshTimer);
      if (syncTimer !== undefined) clearInterval(syncTimer);
    };
  },

  main(ctx) {
    const zinn = resolveZinn();
    ctx.provide(Board, {
      async read(parts) {
        const directory = parts[0] ?? "";
        const raw = await runZinn(zinn, ["task", "list", "--json"], directory);
        return JSON.stringify(summarize(parseBoard(raw), Date.now()));
      },
    });
  },
});
