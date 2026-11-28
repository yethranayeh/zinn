import type { APIRoute } from "astro";
import type {
  RexActionBlock,
  RexActionSection,
  RexProseElement,
} from "../../../components/rex-actions/content";

import {
  actionIntroduction,
  actionSections,
  actionSummaries,
} from "../../../components/rex-actions/content";
import {
  inlineMarkdown,
  inlineMarkdownWithLinkOverrides,
} from "../../../components/inspector/inline";
import { rexActions } from "../../../config/rex-actions";
import { projectLinks } from "../../../config/site";

function fence(language: string, lines: string[]): string {
  return `\`\`\`${language}\n${lines.join("\n")}\n\`\`\``;
}

function proseElementMarkdown(element: RexProseElement): string {
  if (element.kind === "paragraph") {
    if (element.markdownHrefOverrides !== undefined) {
      return inlineMarkdownWithLinkOverrides(element.text, element.markdownHrefOverrides);
    }

    return inlineMarkdown(element.text);
  }

  if (element.kind === "list") {
    return element.items.map((item) => `- ${inlineMarkdown(item)}`).join("\n");
  }

  return [
    inlineMarkdown(element.paragraph),
    fence(element.code.language, element.code.commands),
  ].join("\n\n");
}

function blockMarkdown(block: RexActionBlock): string {
  if (block.kind === "prose") {
    return block.blocks.map(proseElementMarkdown).join("\n\n");
  }

  return fence(block.language, block.commands);
}

function sectionMarkdown(section: RexActionSection): string {
  const sectionBlocks = [`## ${section.title}`];

  if (section.actions !== undefined) {
    for (const action of section.actions) {
      sectionBlocks.push(`### ${action.title}`, ...action.blocks.map(blockMarkdown));
    }
  }

  if (section.blocks !== undefined) {
    sectionBlocks.push(...section.blocks.map(blockMarkdown));
  }

  return sectionBlocks.join("\n\n");
}

export const GET: APIRoute = () =>
  new Response(
    `# ${rexActions.title}

${inlineMarkdown(actionIntroduction)}

${actionSummaries.map(({ action, description }) => `- \`${action}\` ${description}`).join("\n")}

${actionSections.map(sectionMarkdown).join("\n\n")}

[Actions source](${projectLinks.github}/tree/main/integrations/rex/zinn) · [Zinn theme for Rex](https://zinn.sh/integrations/rex/theme.md) · [All integrations](https://zinn.sh/integrations)
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
