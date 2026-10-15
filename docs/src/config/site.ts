export const isProductionSite =
  import.meta.env.PROD && import.meta.env.PUBLIC_SITE_ENV === "production";

export const projectLinks = {
  github: "https://github.com/yethranayeh/zinn",
  npm: "https://www.npmjs.com/package/@zinn-dev/cli",
  twitter: "https://x.com/zinndotsh",
  bluesky: "https://bsky.app/profile/zinn.sh",
  license: "https://raw.githubusercontent.com/yethranayeh/zinn/refs/heads/main/LICENSE",
};

export const homepage = {
  title: "Zinn | Kanban CLI and task manager for the terminal",
  description:
    "Zinn is an experimental kanban CLI and task manager. Manage projects and tasks locally in your terminal.",
};

export const installCommand = "npm i -g @zinn-dev/cli";
