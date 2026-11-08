export const textureNames = ["rules", "scatter", "halftone"] as const;

export type TextureName = (typeof textureNames)[number];

export const defaultTexture: TextureName = "rules";
