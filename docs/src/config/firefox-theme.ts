interface FirefoxTheme {
  id: "halftone" | "lattice";
  name: string;
  description: string;
  addonUrl: string;
  image: string;
  imageAlt: string;
}

export const firefoxTheme = {
  title: "Zinn for Firefox",
  description:
    "Previews and installation instructions for the Zinn themes for Firefox, with light and dark appearances and two textures.",
  path: "/integrations/firefox/theme",
  minimumVersion: "Firefox 157",
  verifiedVersion: "Firefox 160 on macOS",
  introduction:
    "The Zinn color palette for Firefox, with light and dark appearances, in two textures.",
  themes: [
    {
      id: "halftone",
      name: "Zinn Halftone",
      description:
        "A staggered dot grid whose dots grow toward the top edge. It tiles horizontally, so it holds at any window width.",
      addonUrl: "https://addons.mozilla.org/en-US/firefox/addon/zinn-halftone/",
      image:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1794760182/firefox-halftone_h0gq58.png",
      imageAlt:
        "The Zinn Halftone theme across the Firefox tab strip and toolbar, light appearance",
    },
    {
      id: "lattice",
      name: "Zinn Lattice",
      description: "An even dot grid, quiet enough to sit under tab titles.",
      addonUrl: "https://addons.mozilla.org/en-US/firefox/addon/zinn-lattice/",
      image:
        "https://res.cloudinary.com/drwbqceye/image/upload/v1794760182/firefox-lattice_fw52im.png",
      imageAlt: "The Zinn Lattice theme across the Firefox tab strip and toolbar, light appearance",
    },
  ] satisfies FirefoxTheme[],
};
