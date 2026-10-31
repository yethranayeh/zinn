import type { APIRoute } from "astro";

import { SocialCard } from "../../components/SocialCard";
import { installCommand } from "../../config/site";
import { renderSocialCard } from "../../social/render";

export const GET: APIRoute = async () => {
  const png = await renderSocialCard(SocialCard({ command: installCommand }));
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
