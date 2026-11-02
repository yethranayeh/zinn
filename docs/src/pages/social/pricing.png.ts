import type { APIRoute } from "astro";

import { PricingCard } from "../../components/SocialCard";
import { renderSocialCard } from "../../social/render";
import { wordmarkDataUrl } from "../../social/wordmark";

export const GET: APIRoute = async () => {
  const png = await renderSocialCard(PricingCard({ wordmark: wordmarkDataUrl }));
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
