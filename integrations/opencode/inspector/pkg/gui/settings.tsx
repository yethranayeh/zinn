/** @jsxImportSource solid-js */
import type { Ui } from "@opencode/plugin/gui";
import type { Settings } from "./prefs.ts";
import { For } from "solid-js";

import { REFRESH_CHOICES, refreshLabel } from "./prefs.ts";

export function SettingsView(props: {
  ui: Ui;
  settings: () => Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const Switch = props.ui.Switch;
  const Button = props.ui.Button;

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>
      <div data-action="summary">
        <Switch
          label="Show board summary"
          description="The task total, per-column counts and last read, under the window content."
          checked={props.settings().summary}
          onChange={(checked: boolean) => props.update({ summary: checked })}
        />
      </div>

      <div
        data-action="refresh"
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "16px",
        }}
      >
        <div>
          <div style={{ "font-weight": 500 }}>Refresh the board summary every</div>
          <div style={{ opacity: 0.7 }}>How often the strip re-reads Zinn.</div>
        </div>
        <div role="group" aria-label="Refresh interval" style={{ display: "flex", gap: "4px" }}>
          <For each={REFRESH_CHOICES}>
            {(seconds) => (
              <Button
                size="small"
                variant={props.settings().refreshSeconds === seconds ? "neutral" : "ghost"}
                onClick={() => props.update({ refreshSeconds: seconds })}
              >
                {refreshLabel(seconds)}
              </Button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
