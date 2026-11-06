export const inputVariants = {
  base: "min-h-11 font-mono text-base md:text-sm",
  variants: {
    variant: {
      outline: "border border-pewter px-2.5 placeholder:text-muted-foreground",
      bare: "",
    },
  },
  defaultVariants: { variant: "outline" },
} as const;

export type InputVariant = keyof typeof inputVariants.variants.variant;
