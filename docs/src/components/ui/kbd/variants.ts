export const kbdVariants = {
  base: "inline-block whitespace-nowrap font-mono text-[0.85em] leading-none",
  variants: {
    variant: {
      keycap: [
        "rounded-[0.12em] border border-[color-mix(in_srgb,currentColor_45%,transparent)]",
        "border-t-[color-mix(in_srgb,currentColor_15%,transparent)] border-b-[0.18em] border-b-current",
        "bg-[color-mix(in_srgb,currentColor_8%,transparent)] px-[0.35em] pt-[0.12em] pb-[0.2em]",
      ].join(" "),
      terminal: "px-[0.1em]",
    },
  },
  defaultVariants: { variant: "keycap" },
} as const;

export type KbdVariant = keyof typeof kbdVariants.variants.variant;
