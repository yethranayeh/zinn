import type { ScreenshotScene } from "../components/screenshot-gallery";

export const rexTheme = {
  title: "Zinn for Rex",
  description:
    "Screenshots and installation instructions for the Zinn theme for Rex, with light and dark appearances.",
  path: "/integrations/rex/theme",
  site: "https://www.superlogical.com/rex",
  importDocs: "https://www.superlogical.com/rex/docs/reference/mac-settings#import-theme",
  downloads: {
    dark: "/integrations/rex/theme/zinn-dark",
    light: "/integrations/rex/theme/zinn-light",
  },
  verifiedVersion: "Rex Beta 0.1.0 (1696)",
  introduction: "The Zinn color palette for Rex, with light and dark appearances.",
  commands: [
    "curl -fsSL https://zinn.sh/integrations/rex/theme/zinn-dark -o zinn-dark",
    "curl -fsSL https://zinn.sh/integrations/rex/theme/zinn-light -o zinn-light",
    'rex do client.theme.import path="$PWD/zinn-dark"',
    'rex do client.theme.import path="$PWD/zinn-light"',
  ],
};

export const rexScenes: ScreenshotScene[] = [
  {
    id: "shell",
    label: "Shell",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793738548/Screenshot_2026-11-02_at_23.10.07_mstbjr.png",
      light:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1793738547/Screenshot_2026-11-02_at_23.10.27_skpr4r.png",
    },
  },
  {
    id: "editor",
    label: "Editor",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793738547/Screenshot_2026-11-02_at_23.10.09_ujdyah.png",
      light:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1793738546/Screenshot_2026-11-02_at_23.10.29_aszp7y.png",
    },
  },
  {
    id: "agent",
    label: "Agent",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793738547/Screenshot_2026-11-02_at_23.10.12_dltw4l.png",
      light:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1793738546/Screenshot_2026-11-02_at_23.10.31_tldiia.png",
    },
  },
  {
    id: "diff",
    label: "Diff",
    images: {
      dark: "https://res.cloudinary.com/drwbqceye/image/upload/v1793738547/Screenshot_2026-11-02_at_23.10.15_zwr8qq.png",
      light:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1793738546/Screenshot_2026-11-02_at_23.10.33_ukllwx.png",
    },
  },
];
