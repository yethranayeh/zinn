export const inputVariants = {
  base: "min-h-11 font-mono text-base caret-bronze [caret-shape:block] data-deleting:caret-cinnabar md:text-sm",
  variants: {
    variant: {
      recessed: "border-b border-pewter bg-soot/8 px-2.5 placeholder:text-muted-foreground",
      bare: "",
    },
  },
  defaultVariants: { variant: "recessed" },
} as const;

export type InputVariant = keyof typeof inputVariants.variants.variant;
