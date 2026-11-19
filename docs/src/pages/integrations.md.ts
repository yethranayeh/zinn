import type { APIRoute } from "astro";
import { integrationsHub } from "../config/integrations-hub";
import { integrations } from "../config/integrations";

const sections = integrations.map(({ path, host, label, description, markdown }) =>
  [
    `## ${label ?? host}`,
    markdown.introduction ?? description,
    markdown.verification,
    markdown.links(`https://zinn.sh${path}`),
  ]
    .filter(Boolean)
    .join("\n\n"),
);

export const GET: APIRoute = () =>
  new Response(
    `# ${integrationsHub.title}

${integrationsHub.description}

${sections.join("\n\n")}
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
