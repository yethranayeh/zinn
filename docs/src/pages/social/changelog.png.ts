import type { APIRoute } from "astro";

import { ChangelogCard } from "../../components/SocialCard";
import { renderSocialCard } from "../../social/render";
import { wordmarkDataUrl } from "../../social/wordmark";

export const GET: APIRoute = async () => {
  const png = await renderSocialCard(ChangelogCard({ wordmark: wordmarkDataUrl }));
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
