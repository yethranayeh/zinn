import type { APIRoute } from "astro";
import theme from "../../../../../../integrations/rex/theme/zinn-dark?raw";

export const GET: APIRoute = () =>
  new Response(theme, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="zinn-dark"',
    },
  });
