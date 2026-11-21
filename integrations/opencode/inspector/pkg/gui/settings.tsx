/** @jsxImportSource solid-js */
import type { Ui } from "@opencode/plugin/gui";
import type { Settings } from "./prefs.ts";

import { REFRESH_CHOICES, refreshLabel } from "./prefs.ts";

const refreshOptions = REFRESH_CHOICES.map((seconds) => ({
  value: String(seconds),
  label: refreshLabel(seconds),
}));

export function SettingsView(props: {
  ui: Ui;
  title: string;
  settings: () => Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const SettingsLayout = props.ui.SettingsLayout;
  const SettingsSection = props.ui.SettingsSection;
  const SettingsRow = props.ui.SettingsRow;
  const Select = props.ui.Select;
  const Switch = props.ui.Switch;

  return (
    <SettingsLayout
      title={props.title}
      description="Customize the board summary under the window content."
    >
      <SettingsSection>
        <SettingsRow
          id="summary"
          title="Show board summary"
          description="The task total, per-column counts and last read under the window content."
        >
          <Switch
            label="Show board summary"
            hideLabel
            checked={props.settings().summary}
            onChange={(checked: boolean) => props.update({ summary: checked })}
          />
        </SettingsRow>

        <SettingsRow
          id="refresh"
          title="Refresh the board summary every"
          description="How often the strip re-reads Zinn while a session is open. Home and drafts make no reads."
        >
          <Select
            label="Refresh interval"
            options={refreshOptions}
            value={String(props.settings().refreshSeconds)}
            onChange={(value) => props.update({ refreshSeconds: Number(value) })}
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsLayout>
  );
}
