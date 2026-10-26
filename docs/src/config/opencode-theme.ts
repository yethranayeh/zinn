import type { ScreenshotScene } from "../components/screenshot-gallery";

export const opencodeTheme = {
  title: "Zinn for OpenCode",
  description:
    "Screenshots and installation instructions for the Zinn theme for OpenCode, with light and dark appearances.",
  path: "/integrations/opencode/theme",
  download: "/integrations/opencode/theme/zinn.json",
  verifiedVersion: "2.1.4",
  introduction: "The Zinn color palette for the OpenCode TUI, with light and dark appearances.",
  commands: [
    "mkdir -p ~/.config/opencode/themes",
    "cp ~/Downloads/zinn.json ~/.config/opencode/themes/zinn.json",
  ],
};

export const opencodeScenes: ScreenshotScene[] = [
  {
    id: "welcome",
    label: "Welcome",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793041081/01-welcome-dark_dcihxx.png",
    },
  },
  {
    id: "commands",
    label: "Command picker",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793041081/02-command-picker-dark_eej4hk.png",
    },
  },
  {
    id: "slash",
    label: "Slash commands",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793041080/03-slash-commands-dark_fbd0j2.png",
    },
  },
  {
    id: "markdown",
    label: "Markdown",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793041081/04-markdown-dark_ewfvet.png",
      light:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1793041081/05-markdown-light_dvhikt.png",
    },
  },
  {
    id: "code",
    label: "Code & tables",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793041081/06-code-and-tables-dark_vjskv7.png",
      light:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1793041081/07-code-and-tables-light_xqwjxo.png",
    },
  },
  {
    id: "links",
    label: "Links & diagram",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793041082/08-links-and-diagram-dark_owzvyw.png",
      light:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1793041082/09-links-and-diagram-light_h8l8ix.png",
    },
  },
  {
    id: "settings",
    label: "Settings",
    images: {
      light:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1793041082/10-settings-light_ocwvre.png",
    },
  },
  {
    id: "tools",
    label: "Tools & diff",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793041082/11-tool-output-and-diff-dark_euxbvg.png",
    },
  },
  {
    id: "output",
    label: "Code output",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793041083/12-code-output-dark_mzlwd5.png",
    },
  },
];
