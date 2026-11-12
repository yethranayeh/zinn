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

// The inverse pair of an `animated` button. Ink is the text color at rest and becomes the overlay fill. Paper becomes its text.
const sootInk = "[--wipe-ink:var(--color-soot)] [--wipe-paper:var(--color-limestone)]";
const limestoneInk = "[--wipe-ink:var(--color-limestone)] [--wipe-paper:var(--color-soot)]";

// The `animated` hover: an inverse overlay wipes over the button and leaves its corner cells open.
export const buttonWipe = {
  // The button is the hover group for its overlay. Links are never :disabled, so they still wipe.
  base: "group/wipe relative isolate overflow-hidden [--button-wipe-cell:8px]",
  // The stair clip and corner cells live in ButtonContent's style block. The wipe steps once per cell of the stair, 240ms in total.
  overlay:
    "button-wipe absolute inset-0 flex select-none items-center justify-center gap-2 bg-(--wipe-ink) text-(--wipe-paper) transition-[--button-wipe] duration-240 ease-[steps(6)] group-not-disabled/wipe:group-hover/wipe:[--button-wipe:calc(100%+var(--button-wipe-cell)*2)] motion-reduce:transition-none",
  // `trigger` keeps the resting fill under the uncovered part of the button, so the variant's hover tint stays out of the wipe.
  variants: {
    ghost: { trigger: "hover:bg-transparent", pair: sootInk },
    "ghost-inverted": { trigger: "hover:bg-transparent", pair: limestoneInk },
    solid: { trigger: "hover:bg-soot", pair: limestoneInk },
    outline: { trigger: "hover:bg-transparent", pair: sootInk },
  },
} as const;

export type ButtonVariant = keyof typeof buttonVariants.variants.variant;
export type ButtonSize = keyof typeof buttonVariants.variants.size;
