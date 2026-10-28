const packageName = "@zinn-dev/opencode";
const version = "0.1.0";

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
