import type { APIRoute } from "astro";
import { homepage, installCommand, projectLinks } from "../config/site";

export const GET: APIRoute = () => {
  const markdown = `# Zinn

A kanban workflow in the terminal.

${homepage.description}

## Install

\`\`\`sh
${installCommand}
zinn --help
\`\`\`

## Links

- [GitHub](${projectLinks.github})
- [npm](${projectLinks.npm})
`;
  return new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
