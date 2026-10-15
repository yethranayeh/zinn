import type { APIRoute } from "astro";

import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

import alanRegular from "../../assets/fonts/AlanSans-400.ttf?inline";
import alanSemibold from "../../assets/fonts/AlanSans-600.ttf?inline";
import mono from "../../../public/fonts/monoMMM_5.ttf?inline";
import { SocialCard } from "../../components/SocialCard";
import { installCommand } from "../../config/site";

export const GET: APIRoute = async () => {
  const svg = await satori(SocialCard({ command: installCommand }), {
    width: 1200,
    height: 630,
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
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
