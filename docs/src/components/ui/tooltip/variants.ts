export const tooltipVariants = {
  base: "absolute z-20 hidden w-max max-w-[min(20rem,calc(100vw-2rem))] bg-soot px-2.5 py-2 font-mono text-[11px]/normal wrap-anywhere text-soot-foreground before:absolute group-hover/tooltip:block group-has-[:focus-visible]/tooltip:block group-data-tooltip-open/tooltip:block group-data-tooltip-dismissed/tooltip:hidden!",
  variants: {
    placement: {
      "bottom-start": "top-full left-0 mt-1.75 before:inset-x-0 before:-top-2 before:bottom-full",
      "bottom-center":
        "top-full left-1/2 mt-1.75 -translate-x-1/2 before:inset-x-0 before:-top-2 before:bottom-full",
      "bottom-end": "top-full right-0 mt-1.75 before:inset-x-0 before:-top-2 before:bottom-full",
      "top-start": "bottom-full left-0 mb-1.75 before:inset-x-0 before:top-full before:-bottom-2",
      "top-center":
        "bottom-full left-1/2 mb-1.75 -translate-x-1/2 before:inset-x-0 before:top-full before:-bottom-2",
      "top-end": "bottom-full right-0 mb-1.75 before:inset-x-0 before:top-full before:-bottom-2",
      "left-start": "right-full top-0 mr-1.75 before:inset-y-0 before:left-full before:-right-2",
      "left-center":
        "right-full top-1/2 mr-1.75 -translate-y-1/2 before:inset-y-0 before:left-full before:-right-2",
      "left-end": "right-full bottom-0 mr-1.75 before:inset-y-0 before:left-full before:-right-2",
      "right-start": "left-full top-0 ml-1.75 before:inset-y-0 before:right-full before:-left-2",
      "right-center":
        "left-full top-1/2 ml-1.75 -translate-y-1/2 before:inset-y-0 before:right-full before:-left-2",
      "right-end": "left-full bottom-0 ml-1.75 before:inset-y-0 before:right-full before:-left-2",
    },
  },
  defaultVariants: { placement: "bottom-end" },
} as const;

export type TooltipPlacement = keyof typeof tooltipVariants.variants.placement;
