export const tableVariants = {
  base: "group/table w-full border-collapse border border-soot text-base leading-[1.55]",
  variants: {
    variant: {
      ledger: "bg-bone",
      soot: "bg-transparent",
    },
  },
  defaultVariants: { variant: "ledger" },
} as const;

/**
 * Only Table takes the variant
 * The parts read it from the table's `data-variant` through the `group/table` name
 */
export const tableHeadVariants = {
  ledger: [
    "border-b-2 border-b-soot bg-clay px-4 py-2 text-left font-mono text-xs leading-[1.55] font-normal tracking-[0.08em] whitespace-nowrap text-limestone uppercase",
    "not-first:border-l not-first:border-l-limestone/30",
  ].join(" "),
  soot: [
    "group-data-[variant=soot]/table:border-b-0 group-data-[variant=soot]/table:bg-soot group-data-[variant=soot]/table:px-5 group-data-[variant=soot]/table:py-2.5",
    "group-data-[variant=soot]/table:text-[0.8125rem] group-data-[variant=soot]/table:tracking-[0.02em] group-data-[variant=soot]/table:normal-case",
    "group-data-[variant=soot]/table:not-first:border-l-0",
  ].join(" "),
} as const;

export const tableCellVariants = {
  ledger: [
    "border-b border-b-soot/18 px-4 py-2.5 align-top wrap-anywhere not-first:border-l not-first:border-l-soot/18",
    "[&_code]:bg-limestone/70! [&_code]:inset-ring [&_code]:inset-ring-soot/30 [&_code]:whitespace-nowrap",
  ].join(" "),
  soot: [
    "group-data-[variant=soot]/table:border-b-soot/14 group-data-[variant=soot]/table:px-5 group-data-[variant=soot]/table:py-3.5",
    "group-data-[variant=soot]/table:wrap-break-word group-data-[variant=soot]/table:not-first:border-l-0",
  ].join(" "),
} as const;

export const tableRowVariants = {
  ledger: "even:bg-[color-mix(in_srgb,var(--color-limestone)_45%,var(--color-bone))]",
  soot: [
    "group-data-[variant=soot]/table:even:bg-[color-mix(in_srgb,var(--color-bone)_40%,transparent)]",
    "group-data-[variant=soot]/table:[&:last-child>td]:border-b-soot",
  ].join(" "),
} as const;

export type TableVariant = keyof typeof tableVariants.variants.variant;
