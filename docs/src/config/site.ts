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

export const minimumNodeVersion = "24.15.0";

export const agentSetupPrompt = `Install Zinn (https://zinn.sh), a command-line kanban board.
1. Run \`node --version\`. Zinn needs Node ${minimumNodeVersion} or newer. If Node is missing or older, stop and tell me; do not change my Node installation.
2. Run \`${installCommand}\`, then \`zinn --version\`.
3. Install the Zinn skill: \`npx skills add yethranayeh/zinn --skill zinn -g -y\`.
4. Read \`zinn --help\`.
Tell me what you installed. Do not create projects or tasks until I ask.`;
