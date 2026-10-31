export const separatorVariants = {
  base: "shrink-0 bg-pewter",
  variants: {
    orientation: {
      horizontal: "h-px w-full",
      vertical: "w-px self-stretch",
    },
  },
  defaultVariants: { orientation: "horizontal" },
} as const;

export type SeparatorOrientation = keyof typeof separatorVariants.variants.orientation;
