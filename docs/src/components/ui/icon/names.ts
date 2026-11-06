// The symbols in public/icons.svg that Icon can currenlty show
export const iconNames = [
  "external-link",
  "copy",
  "check",
  "arrow-left",
  "arrow-right",
  "download",
  "close",
  "search",
] as const;

export type IconName = (typeof iconNames)[number];
