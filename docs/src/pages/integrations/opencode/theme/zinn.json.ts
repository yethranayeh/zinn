import type { APIRoute } from "astro";
import theme from "../../../../../../integrations/opencode/theme/zinn.json?raw";

export const GET: APIRoute = () =>
  new Response(theme, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="zinn.json"',
    },
  });
