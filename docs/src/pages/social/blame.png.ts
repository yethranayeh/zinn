import type { APIRoute } from "astro";

import { BlameCard } from "../../components/SocialCard";
import { renderSocialCard } from "../../social/render";
import { wordmarkDataUrl } from "../../social/wordmark";

export const GET: APIRoute = async () => {
  const png = await renderSocialCard(BlameCard({ wordmark: wordmarkDataUrl }));
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
