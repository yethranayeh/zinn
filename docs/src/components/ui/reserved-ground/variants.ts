export const reservedGroundVariants = {
  variants: {
    texture: {
      hatch:
        "bg-[image:repeating-linear-gradient(315deg,color-mix(in_srgb,var(--color-soot)_12%,transparent)_0_1px,transparent_1px_8px)]",
      "hatch-reverse":
        "bg-[image:repeating-linear-gradient(45deg,color-mix(in_srgb,var(--color-soot)_12%,transparent)_0_1px,transparent_1px_8px)]",
      ruled:
        "bg-[image:repeating-linear-gradient(to_bottom,transparent_0_21.4px,color-mix(in_srgb,var(--color-pewter)_30%,transparent)_21.4px_22.4px)]",
      lines:
        "bg-[image:repeating-linear-gradient(to_right,color-mix(in_srgb,var(--color-soot)_12%,transparent)_0_2px,transparent_2px_12px)]",
      halftone:
        "bg-[image:radial-gradient(circle_at_3px_3px,color-mix(in_srgb,var(--color-soot)_16%,transparent)_0_1.1px,transparent_1.3px)] bg-size-[6px_6px]",
      scatter:
        "bg-[color-mix(in_srgb,var(--color-soot)_12%,transparent)] mask-size-[32px_32px] mask-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2732%27%20height=%2732%27%3E%3Cpath%20d=%27M5,1h2v2h-2zM13,1h2v2h-2zM25,1h2v2h-2zM1,5h2v2h-2zM9,5h2v2h-2zM13,5h2v2h-2zM25,5h2v2h-2zM29,5h2v2h-2zM21,9h2v2h-2zM29,9h2v2h-2zM1,13h2v2h-2zM5,13h2v2h-2zM17,13h2v2h-2zM5,17h2v2h-2zM9,17h2v2h-2zM13,17h2v2h-2zM5,21h2v2h-2zM17,21h2v2h-2zM5,25h2v2h-2zM13,25h2v2h-2zM25,25h2v2h-2zM1,29h2v2h-2z%27%20fill=%27%23fff%27/%3E%3C/svg%3E)]",
    },
  },
  defaultVariants: { texture: "hatch" },
} as const;

export type ReservedGroundTexture = keyof typeof reservedGroundVariants.variants.texture;
