export const rexTheme = {
  title: "Zinn for Rex",
  description:
    "Download and installation instructions for the Zinn theme for Rex, with light and dark appearances.",
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
