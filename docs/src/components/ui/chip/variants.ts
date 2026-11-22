export const chipVariants = {
  base: "inline-block bg-soot px-2.5 py-1.25 font-mono text-xs leading-normal text-soot-foreground",
  // A chip with a mark is a flex row, so the mark and the text inside the label stay apart from each other.
  marked: "inline-flex bg-soot font-mono text-xs leading-normal text-soot-foreground",
  variants: {
    variant: {
      split: {
        root: "items-stretch border border-soot",
        mark: "flex items-center bg-limestone px-1 text-soot",
        label: "px-2.5 py-1",
      },
      inline: {
        root: "items-center gap-1.5 py-1 pr-2.5 pl-1.5",
        mark: "flex",
        label: "",
      },
    },
  },
  defaultVariants: { variant: "split" },
} as const;

export type ChipVariant = keyof typeof chipVariants.variants.variant;
