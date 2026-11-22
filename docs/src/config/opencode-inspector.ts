import type { AnnotatedFigureData } from "../components/inspector/annotated-figure";
import { latestReleaseVersion } from "./latest-release";

const packageName = "@zinn-dev/opencode";
const version = latestReleaseVersion("opencode");
const [versionMajor, versionMinor] = version.split(".");
// Install the latest minor line, so a patch release does not rewrite the install spec.
const installRange = `^${versionMajor}.${versionMinor}.0`;
const installLine = `${versionMajor}.${versionMinor}.x`;
const verifiedVersion = "2.3.2";
const [openCodeMajor, openCodeMinor] = verifiedVersion.split(".");
const openCodeRange = `${openCodeMajor}.${openCodeMinor}.x`;

export interface InspectorOption {
  name: string;
  default: string;
  behavior: string;
}

export const opencodeInspector = {
  title: "Zinn task inspector",
  description:
    "Inspect Zinn tasks in the OpenCode TUI and keep the default project's board summary in OpenCode Desktop.",
  path: "/integrations/opencode/inspector",
  packageName,
  version,
  installRange,
  installLine,
  package: `${packageName}@${installRange}`,
  verifiedVersion,
  openCodeRange,
  openTuiVersion: "0.8.4",
  minimumCliVersion: "0.45.0",
  options: [
    {
      name: "rows",
      default: "1",
      behavior: "Accepts `1` or `2`. `2` includes column, priority and labels.",
    },
    {
      name: "current",
      default: '"off"',
      behavior:
        'Accepts `"off"` or `"glyph"`. `"glyph"` marks tasks with recorded activity from this conversation family.',
    },
    {
      name: "renewClaims",
      default: "true",
      behavior:
        "Renews the claims this conversation holds after a turn that ran a tool, on by default, with about four calls per hour per held claim in use on a 30 minute lease and none while idle.",
    },
  ] satisfies InspectorOption[],
};

const exampleOptions = { rows: 2, current: "glyph" };

export const inspectorPluginConfig = {
  server: JSON.stringify({ plugins: [opencodeInspector.package] }, null, "\t"),
  tui: JSON.stringify(
    { plugins: [{ package: opencodeInspector.package, options: exampleOptions }] },
    null,
    "\t",
  ),
};

export interface InspectorCollageState {
  label: string;
  image: string;
  alt: string;
  height: number;
}

export interface InspectorCollagePart {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  callout: { top: number; right: number };
  backdrop?: boolean;
  states: Array<InspectorCollageState>;
}

const collageAssets = {
  base: "https://res.cloudinary.com/drwbqceye/image/upload/v1795373606/base_rjvdw8_tgbgwt.png",
  sidepanelRows2:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1795373607/sidepanel-rows-2_aszk0i_kyoxds.png",
  sidepanelRows1:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1795373606/sidepanel-rows-1_tjtryl_nkhtju.png",
  detailsZoc2:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1793456931/details-zoc-2_wajnpy.png",
  detailsZoc9:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1793456931/details-zoc-9_dtekzb.png",
  paletteCommands:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1793468909/palette-commands-zinn_vd9nvg.png",
  paletteAllTasks:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1795360227/palette-all-tasks_yxkcul.png",
  keysInChat:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1793468909/palette-keys-in-chat_h2mp95.png",
  composer:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1793468908/composer-zinn_hxs8ok.png",
};

export const inspectorCollage = {
  base: collageAssets.base,
  width: 2992,
  height: 1780,
  caption: "The sidepanel, task details, command palette and composer revealed from the base.",
  parts: [
    {
      id: "sidepanel",
      label: "Sidepanel",
      x: 2372,
      y: 442,
      width: 622,
      callout: { top: 15, right: 21.8 },
      states: [
        {
          label: "Two rows",
          image: collageAssets.sidepanelRows2,
          alt: "Sidepanel with two rows per task",
          height: 441,
        },
        {
          label: "One row",
          image: collageAssets.sidepanelRows1,
          alt: "Sidepanel with one row per task",
          height: 441,
        },
      ],
    },
    {
      id: "details",
      label: "Task details",
      x: 874,
      y: 440,
      width: 1232,
      callout: { top: 28.025, right: 75 },
      backdrop: true,
      states: [
        {
          label: "ZOC-2",
          image: collageAssets.detailsZoc2,
          alt: "Task details for ZOC-2",
          height: 644,
        },
        {
          label: "ZOC-9",
          image: collageAssets.detailsZoc9,
          alt: "Task details for ZOC-9",
          height: 532,
        },
      ],
    },
    {
      id: "palette",
      label: "Command palette",
      x: 1070,
      y: 440,
      width: 840,
      callout: { top: 40, right: 72 },
      backdrop: true,
      states: [
        {
          label: "Zinn",
          image: collageAssets.paletteCommands,
          alt: "Command palette with the Zinn commands",
          height: 756,
        },
        {
          label: "All tasks",
          image: collageAssets.paletteAllTasks,
          alt: "Zinn task picker listing all tasks",
          height: 756,
        },
        {
          label: "This chat",
          image: collageAssets.keysInChat,
          alt: "Zinn task picker listing task keys from this chat",
          height: 280,
        },
      ],
    },
    {
      id: "composer",
      label: "Composer",
      x: 54,
      y: 1279,
      width: 2290,
      callout: { top: 65, right: 77 },
      states: [
        {
          label: "Slash menu",
          image: collageAssets.composer,
          alt: "Slash command list above the composer",
          height: 406,
        },
      ],
    },
  ] satisfies InspectorCollagePart[],
};

const desktopAssets = {
  bottomSlot:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1795272929/desktop-bottom-slot_nrtl5n.png",
};

export const desktopBottomSlot: AnnotatedFigureData = {
  src: desktopAssets.bottomSlot,
  width: 2784,
  height: 1734,
  alt: "OpenCode Desktop with the Zinn bottom slot showing the demo board's task counts",
  caption: "The Zinn bottom slot in OpenCode Desktop, reading the demo board.",
  annotations: [
    {
      label: "Wordmark",
      text: "The ZINN wordmark. It opens the Zinn documentation.",
      x: 112,
      y: 1526,
      width: 126,
      height: 59,
    },
    {
      label: "Task total",
      text: "The active tasks in the default project.",
      x: 238,
      y: 1526,
      width: 192,
      height: 59,
    },
    {
      label: "Column counts",
      text: "One cell for each column with tasks, in board order. Backlog and cancelled ones are dimmed.",
      x: 430,
      y: 1526,
      width: 700,
      height: 59,
    },
    {
      label: "Category ink",
      text: "Columns with the done category are colored green.",
      x: 1130,
      y: 1526,
      width: 348,
      height: 59,
    },
    {
      label: "Hatched spacer",
      text: "The elastic seam between the counts and the read stamp. It absorbs the space the columns leave.",
      x: 1478,
      y: 1526,
      width: 984,
      height: 59,
    },
    {
      label: "Read stamp",
      text: "The last time the board was read. A failed read says no read and keeps the last counts.",
      x: 2462,
      y: 1526,
      width: 208,
      height: 59,
    },
  ],
};
