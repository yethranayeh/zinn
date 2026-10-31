import { Resvg } from "@resvg/resvg-js";

import wordmarkSvg from "../../public/art/zinn-wordmark.svg?raw";

// Twice the 240px card width.
const rasterWidth = 480;
const wordmarkPng = new Resvg(wordmarkSvg, { fitTo: { mode: "width", value: rasterWidth } })
  .render()
  .asPng();

export const wordmarkDataUrl = `data:image/png;base64,${Buffer.from(wordmarkPng).toString("base64")}`;
