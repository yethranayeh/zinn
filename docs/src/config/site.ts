export const isProductionSite =
  import.meta.env.PROD && import.meta.env.PUBLIC_SITE_ENV === "production";

export const projectLinks = {
  github: "https://github.com/yethranayeh/zinn",
  npm: "https://www.npmjs.com/package/@zinn-dev/cli",
  license: "https://raw.githubusercontent.com/yethranayeh/zinn/refs/heads/main/LICENSE"
};

export const homepage = {
  title: "Zinn | A kanban workflow in the terminal",
  description:
    "Zinn is an experimental command-line kanban tool. Manage projects and tasks locally in your terminal. Requires Bun."
};

export const installCommand = "bun add -g @zinn-dev/cli";
