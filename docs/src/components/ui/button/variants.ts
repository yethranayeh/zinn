export const buttonVariants = {
  base: "inline-flex cursor-pointer items-center justify-center gap-2 font-mono no-underline hover:no-underline disabled:cursor-wait disabled:opacity-50",
  variants: {
    variant: {
      ghost: "text-left hover:bg-soot/8 focus-visible:outline-offset-2",
      "ghost-inverted": "text-left hover:bg-limestone/8 focus-visible:outline-offset-2",
      solid:
        "border border-soot bg-soot text-soot-foreground hover:bg-soot/90 focus-visible:outline-offset-4",
      outline: "border border-soot hover:bg-soot/8 focus-visible:outline-offset-4",
    },
    size: {
      default: "min-h-11 px-2.5 py-2.5 text-xs",
      large: "min-h-11 px-4 py-3 text-sm",
      icon: "size-11 p-2.5 text-xs",
      "responsive-icon": "p-2.5 text-xs md:size-11",
    },
  },
  defaultVariants: { variant: "ghost", size: "default" },
} as const;

export type ButtonVariant = keyof typeof buttonVariants.variants.variant;
export type ButtonSize = keyof typeof buttonVariants.variants.size;
