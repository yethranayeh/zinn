import type { AnnotatedFigureData } from "./annotated-figure";
import {
  desktopBottomSlot,
  inspectorPluginConfig,
  opencodeInspector,
} from "../../config/opencode-inspector";

// Inline text carries `code`, **bold**, [links](/path) and <kbd>keys</kbd>.
export type InspectorInline = string;

export type InspectorProseBlock =
  | { kind: "paragraph"; text: InspectorInline }
  | { kind: "list"; items: Array<InspectorInline> }
  | { kind: "code"; label: string; language: string; code: string }
  | { kind: "table"; columns: Array<InspectorInline>; rows: Array<InspectorInline>[] };

export type InspectorBlock = InspectorProseBlock | { kind: "figure"; figure: AnnotatedFigureData };

export interface InspectorSection {
  heading: string;
  id?: string;
  blocks: InspectorBlock[];
}

// Give plain-word headings the same slug-based ID that the other pages generate
export const sectionId = (section: InspectorSection): string =>
  section.id ?? section.heading.toLowerCase().replaceAll(" ", "-");

export const inspectorIntroduction =
  "The inspector reads tasks, labels and recorded activity through the local Zinn CLI. It uses the same [data directory and settings](/docs/settings) as the CLI running in that environment. It loads tasks from the default project, or from every project when no default is set, including archived tasks mentioned in the chat. The task count includes only active tasks. With a remote OpenCode server, the TUI inspector still runs locally and reads the local CLI's database. OpenCode Desktop also shows an experimental board summary for the default project.";

export const inspectorSections: InspectorSection[] = [
  {
    heading: "Requirements",
    blocks: [
      {
        kind: "list",
        items: [
          `OpenCode ${opencodeInspector.verifiedVersion}.`,
          `Zinn CLI ${opencodeInspector.minimumCliVersion} or newer on the terminal's \`PATH\`, with a database it can read.`,
          `The inspector package \`${opencodeInspector.package}\`.`,
        ],
      },
    ],
  },
  {
    heading: "Install",
    id: "installation",
    blocks: [
      {
        kind: "paragraph",
        text: "Install the package in two OpenCode configuration files, keeping any existing plugin entries.",
      },
      {
        kind: "paragraph",
        text: "Add it to `~/.config/opencode/opencode.json` for the server and desktop entries:",
      },
      {
        kind: "code",
        label: "opencode.json",
        language: "json",
        code: inspectorPluginConfig.server,
      },
      {
        kind: "paragraph",
        text: "Add the same package to `~/.config/opencode/cli.json` with the inspector options:",
      },
      {
        kind: "code",
        label: "cli.json",
        language: "json",
        code: inspectorPluginConfig.tui,
      },
      {
        kind: "paragraph",
        text: "OpenCode loads the server and desktop entries from `opencode.json` and the TUI inspector from `cli.json`. Both entries use the same spec, so they share one package download. The `cli.json` object carries the TUI options. OpenCode applies `opencode.json` options to the server and desktop entries, not to the TUI inspector.",
      },
      {
        kind: "paragraph",
        text: "OpenCode loads these entries through its native [plugin configuration](https://opencode.ai/v2/docs/cli/plugins/). Start OpenCode, open a conversation and mention a task key from your database. Select the task to inspect it.",
      },
    ],
  },
  {
    heading: "Find and inspect tasks",
    blocks: [
      {
        kind: "paragraph",
        text: "Mentioned archived tasks are recognized and their details open. Run `/zinn` to pick an active task. The command palette also offers **Zinn: task keys in this chat** and **Zinn: pick a task from the board**.",
      },
      {
        kind: "paragraph",
        text: "Task details include status, priority, labels, the first paragraph of the description, relations, comment count and a short excerpt of the latest mention in the conversation. When the detail is opened from a task key mentioned in this chat, it also says how many times that task was mentioned. Select a related task to open it in the same dialog, then use back to return. Long relation lists scroll in place. Close the dialog with its close control or <kbd>Esc</kbd>. Unknown keys are shown when their project prefix appears among the loaded tasks. Select the ZINN heading to refresh task and label data.",
      },
    ],
  },
  {
    heading: "Desktop board summary",
    blocks: [
      {
        kind: "paragraph",
        text: "OpenCode Desktop shows an experimental board summary in the bottom slot. It reads the default project's board in the current session's directory. A successful read stamps `synced HH:MM`. A failed read keeps the last counts and stamps `no read`, with the error on hover.",
      },
      {
        kind: "paragraph",
        text: "The Zinn settings page turns the strip on or off and sets the refresh interval to 30 seconds, 1 minute, 5 minutes or 15 minutes. The default is 1 minute.",
      },
      { kind: "figure", figure: desktopBottomSlot },
    ],
  },
  {
    heading: "Options",
    id: "options",
    blocks: [
      {
        kind: "table",
        columns: ["Option", "Default", "Behavior"],
        rows: opencodeInspector.options.map((option) => [
          `\`${option.name}\``,
          `\`${option.default}\``,
          option.behavior,
        ]),
      },
      {
        kind: "paragraph",
        text: "Change these from the command palette with `Zinn: settings`. The menu applies a choice immediately, and a value set there overrides the same value in `cli.json` and survives restarts. Reset in the same menu returns to the file's values.",
      },
    ],
  },
  {
    heading: "Conversation marks",
    blocks: [
      {
        kind: "paragraph",
        text: "A conversation mark means a task has recorded activity whose session or thread ID matches the current conversation, its root or one of its children. A mention alone does not create a mark. The mark records activity, rather than an assignment or ownership claim.",
      },
      {
        kind: "paragraph",
        text: "OpenCode's native shell session ID is recorded by Zinn as a thread ID. An explicit `ZINN_SESSION_ID` and `ZINN_THREAD_ID` pair takes precedence. The inspector recognizes both routes. See [actor identity](/docs/cli/identity#who-am-i) for the CLI contract.",
      },
      {
        kind: "paragraph",
        text: "The mark animates while OpenCode reports that conversation as busy. Busy state comes from the host independently of the task's recorded activity. Tasks in Done keep their green treatment.",
      },
    ],
  },
  {
    heading: "Claim renewal",
    blocks: [
      {
        kind: "paragraph",
        text: "After a turn that runs at least one tool, the inspector renews every live [claim](/docs/cli/next#claim-tasks) held by the conversation it shows, including claims held by its subagents, whether or not the chat mentions the task. It runs `zinn task heartbeat` as the [claim's holder](/docs/cli/identity#who-am-i). A turn that only writes text does not renew, and opening the panel does not renew.",
      },
      {
        kind: "paragraph",
        text: "A claim renews once at least half its lease has passed since its last renewal, so a claim receives at most two heartbeats per lease, about four calls per hour per held claim on a 30 minute lease. An expired claim is not renewed, so a lapse stays visible, and a claim is also not renewed when another holder has taken it or when 24 hours pass without a change to the task. There is no timer, so an idle conversation makes no calls, and renewal adds no board read: it uses the task list the inspector already loaded. Renewal runs only while the conversation is shown in the TUI inspector's sidebar. A conversation in another tab, OpenCode Desktop or `opencode run` does not renew.",
      },
    ],
  },
  {
    heading: "Compatibility",
    blocks: [
      {
        kind: "paragraph",
        text: `Version ${opencodeInspector.version} targets OpenCode ${opencodeInspector.openCodeRange}, verified on ${opencodeInspector.verifiedVersion}, and its OpenTUI ${opencodeInspector.openTuiVersion} runtime. The \`${opencodeInspector.installRange}\` entry installs ${opencodeInspector.installLine} patches. Move to a new inspector minor only when its release notes name the OpenCode version it supports.`,
      },
    ],
  },
  {
    heading: "Update",
    blocks: [
      {
        kind: "paragraph",
        text: "OpenCode updates the package from the `opencode.json` entry. In OpenCode Desktop, open Settings › Extensions › Plugins, select Check for updates, then Update on the package. In the terminal, run `opencode plugin check` and `opencode plugin update`.",
      },
      {
        kind: "paragraph",
        text: `Both entries use the same spec, so an update installs the new ${opencodeInspector.installLine} package for both. Restart OpenCode to load the new TUI inspector and desktop entry. An exact version is skipped by the update check, so keep the \`${opencodeInspector.installRange}\` range.`,
      },
    ],
  },
  {
    heading: "Remove",
    blocks: [
      {
        kind: "paragraph",
        text: "Remove the package entry from each configuration file where you added it, then start OpenCode again. Your Zinn projects, tasks and activity remain in the database.",
      },
    ],
  },
];
