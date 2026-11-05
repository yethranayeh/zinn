import type { APIRoute } from "astro";

import { PricingCard } from "../../components/SocialCard";
import { pricingTotals, sizeLabel } from "../../config/pricing";
import { renderSocialCard } from "../../social/render";
import { wordmarkDataUrl } from "../../social/wordmark";

export const GET: APIRoute = async () => {
  const png = await renderSocialCard(
    PricingCard({ wordmark: wordmarkDataUrl, download: sizeLabel(pricingTotals.download) }),
  );
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
