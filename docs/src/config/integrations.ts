import { cloudinaryImage } from "../images/cloudinary";
import { firefoxTheme } from "./firefox-theme";
import { opencodeInspector } from "./opencode-inspector";
import { opencodeScenes, opencodeTheme } from "./opencode-theme";
import { rexScenes, rexTheme } from "./rex-theme";

const opencodePreview = opencodeScenes.find((scene) => scene.id === "code")!;
const rexPreview = rexScenes.find((scene) => scene.id === "shell")!;
const [halftone, lattice] = firefoxTheme.themes;

type IntegrationEntry = {
  path: string;
  title: string;
  host: string;
  label?: string;
  description: string;
  action: string;
  image?: { src: string; alt: string; width: number; height: number; banner?: boolean };
  markdown: {
    introduction?: string;
    verification?: string;
    links: (url: string) => string;
  };
  discovery: { title?: string; description: string };
};

export const integrations: IntegrationEntry[] = [
  {
    path: "/integrations/claude-code",
    title: "Zinn for Claude Code",
    host: "Claude Code",
    description:
      "Task keys with their status in Claude's replies, a task and board pane, and session identity for Zinn's activity log.",
    action: "View setup",
    markdown: {
      links: (url) =>
        `[View Claude Code setup](${url}) for installation, the pane, options, identity variables, updates and removal.`,
    },
    discovery: {
      title: "Claude Code integration",
      description:
        "Plugin installation from GitHub, task keys in replies, the task pane, options, identity variables, update and removal.",
    },
  },
  {
    path: opencodeInspector.path,
    title: opencodeInspector.title,
    host: "OpenCode",
    label: "OpenCode task inspector",
    description: opencodeInspector.description,
    action: "View inspector",
    markdown: {
      links: (url) =>
        `[View the inspector](${url}) for setup, options, compatibility, update and removal.`,
    },
    discovery: {
      description: "Native package setup, task marks, compatibility, update and removal.",
    },
  },
  {
    path: "/integrations/codex",
    title: "Zinn for Codex",
    host: "Codex",
    description:
      "Local task inspection and optional execution-identity hooks alongside a Codex desktop chat.",
    action: "View setup",
    markdown: {
      links: (url) =>
        `[View Codex setup](${url}) for GitHub installation, database selection, hook trust, privacy, compatibility and removal.`,
    },
    discovery: {
      title: "Codex integration",
      description:
        "Plugin installation from GitHub, local task inspection, database selection, hook trust, identity and privacy settings.",
    },
  },
  {
    path: opencodeTheme.path,
    title: "Zinn theme",
    host: "OpenCode",
    label: "OpenCode theme",
    description: opencodeTheme.introduction,
    action: "View theme",
    image: {
      src: cloudinaryImage(opencodePreview.images.dark!, 1280),
      alt: "The Zinn theme displaying code and tables in OpenCode",
      width: 2840,
      height: 1640,
    },
    markdown: {
      verification: `Verified with OpenCode ${opencodeTheme.verifiedVersion}.`,
      links: (url) =>
        `[View theme](${url}) or [download zinn.json](https://zinn.sh${opencodeTheme.download}).`,
    },
    discovery: {
      description: "Screenshots, download and setup for the Zinn theme in light and dark.",
    },
  },
  {
    path: rexTheme.path,
    title: "Zinn theme",
    host: "Rex",
    label: "Rex theme",
    description: rexTheme.introduction,
    action: "View theme",
    image: {
      src: cloudinaryImage(rexPreview.images.dark!, 1280),
      alt: "The Zinn theme showing a shell session in Rex",
      width: 3248,
      height: 1900,
    },
    markdown: {
      introduction: rexTheme.introduction.replace("Rex", `[Rex](${rexTheme.site})`),
      verification: `Verified with ${rexTheme.verifiedVersion}.`,
      links: (url) =>
        `[View theme](${url}) or [download zinn-dark](https://zinn.sh${rexTheme.downloads.dark}) and [zinn-light](https://zinn.sh${rexTheme.downloads.light}).`,
    },
    discovery: {
      description: "Screenshots, download and setup for the Zinn theme in Rex, in light and dark.",
    },
  },
  {
    path: firefoxTheme.path,
    title: "Zinn theme",
    host: "Firefox",
    label: "Firefox theme",
    description: firefoxTheme.introduction,
    action: "View theme",
    image: {
      src: halftone!.image,
      alt: halftone!.imageAlt,
      width: 680,
      height: 92,
      banner: true,
    },
    markdown: {
      links: (url) =>
        `[View theme](${url}) or install [${halftone!.name}](${halftone!.addonUrl}) or [${lattice!.name}](${lattice!.addonUrl}) from Mozilla Add-ons.`,
    },
    discovery: {
      description: "Light and dark themes in two textures, installed from Mozilla Add-ons.",
    },
  },
];
