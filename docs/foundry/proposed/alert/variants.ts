export const alertVariants = {
  base: "flex flex-col gap-2 border border-l-6 px-3.5 py-2.5",
  variants: {
    variant: {
      note: "border-soot/30 border-l-soot bg-soot/4",
      error: "border-cinnabar/40 border-l-cinnabar bg-cinnabar/6",
    },
  },
  defaultVariants: { variant: "note" },
} as const;

export type AlertVariant = keyof typeof alertVariants.variants.variant;
