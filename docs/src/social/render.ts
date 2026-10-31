import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

import alanRegular from "../assets/fonts/AlanSans-400.ttf?inline";
import alanSemibold from "../assets/fonts/AlanSans-600.ttf?inline";
import mono from "../../public/fonts/monoMMM_5.ttf?inline";

const cardWidth = 1200;
const cardHeight = 630;

export async function renderSocialCard(
  element: Parameters<typeof satori>[0],
): Promise<Uint8Array<ArrayBuffer>> {
  const svg = await satori(element, {
    width: cardWidth,
    height: cardHeight,
    fonts: [
      {
        name: "Alan Sans",
        data: Buffer.from(alanRegular.split(",")[1]!, "base64"),
        weight: 400,
      },
      {
        name: "Alan Sans",
        data: Buffer.from(alanSemibold.split(",")[1]!, "base64"),
        weight: 600,
      },
      {
        name: "MonoMMM",
        data: Buffer.from(mono.split(",")[1]!, "base64"),
        weight: 400,
      },
    ],
  });
  const png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();

  return new Uint8Array(png);
}
