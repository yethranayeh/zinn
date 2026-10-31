const packageName = "@zinn-dev/opencode";
const version = "0.2.0";

export const opencodeInspector = {
  title: "Zinn task inspector",
  description:
    "Inspect Zinn tasks mentioned in an OpenCode conversation without leaving the terminal.",
  path: "/integrations/opencode/inspector",
  packageName,
  version,
  package: `${packageName}@${version}`,
  verifiedVersion: "2.2.0",
  minimumCliVersion: "0.41.0",
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
  states: InspectorCollageState[];
}

const collageAssets = {
  base: "https://res.cloudinary.com/drwbqceye/image/upload/v1793456931/base_rjvdw8.png",
  sidepanelRows2:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1793456931/sidepanel-rows-2_aszk0i.png",
  sidepanelRows1:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1793456931/sidepanel-rows-1_tjtryl.png",
  detailsZoc2:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1793456931/details-zoc-2_wajnpy.png",
  detailsZoc9:
    "https://res.cloudinary.com/drwbqceye/image/upload/v1793456931/details-zoc-9_dtekzb.png",
};

export const inspectorCollage = {
  base: collageAssets.base,
  width: 2994,
  height: 1570,
  caption: "The sidepanel and task details in two states each.",
  parts: [
    {
      id: "sidepanel",
      label: "Sidepanel",
      x: 2372,
      y: 142,
      width: 622,
      callout: { top: 15, right: 21.8 },
      states: [
        {
          label: "Two rows",
          image: collageAssets.sidepanelRows2,
          alt: "Sidepanel with two rows per task",
          height: 1428,
        },
        {
          label: "One row",
          image: collageAssets.sidepanelRows1,
          alt: "Sidepanel with one row per task",
          height: 1428,
        },
      ],
    },
    {
      id: "details",
      label: "Task details",
      x: 874,
      y: 440,
      width: 1232,
      callout: { top: 28.025, right: 72 },
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
  ] satisfies InspectorCollagePart[],
};
