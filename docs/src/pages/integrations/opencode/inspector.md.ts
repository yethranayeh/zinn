import type { APIRoute } from "astro";
import type { InspectorBlock, InspectorSection } from "../../../components/inspector/content";
import {
  inspectorIntroduction,
  inspectorSections,
} from "../../../components/inspector/content";
import { inlineMarkdown } from "../../../components/inspector/inline";
import { inspectorCollage, opencodeInspector } from "../../../config/opencode-inspector";
import { projectLinks } from "../../../config/site";

function blockMarkdown(block: InspectorBlock): string {
  switch (block.kind) {
    case "paragraph":
      return inlineMarkdown(block.text);
    case "list":
      return block.items.map((item) => `- ${inlineMarkdown(item)}`).join("\n");
    case "code":
      return `\`\`\`${block.language}\n${block.code}\n\`\`\``;
    case "table":
      return [
        `| ${block.columns.map(inlineMarkdown).join(" | ")} |`,
        `| ${block.columns.map(() => "---").join(" | ")} |`,
        ...block.rows.map((row) => `| ${row.map(inlineMarkdown).join(" | ")} |`),
      ].join("\n");
    case "figure":
      return [
        `![${block.figure.alt}](${block.figure.src})`,
        block.figure.annotations
          .map((annotation, index) => `${index + 1}. **${annotation.label}.** ${annotation.text}`)
          .join("\n"),
      ].join("\n\n");
  }
}

function sectionMarkdown(section: InspectorSection): string {
  return [`## ${section.heading}`, ...section.blocks.map(blockMarkdown)].join("\n\n");
}

export const GET: APIRoute = () =>
  new Response(
    `# ${opencodeInspector.title}

Experimental. ${opencodeInspector.description}

${inlineMarkdown(inspectorIntroduction)}

## Screenshots

${inspectorCollage.caption}

${inspectorSections.map(sectionMarkdown).join("\n\n")}

Verified with OpenCode ${opencodeInspector.verifiedVersion}.

[Inspector source](${projectLinks.github}/tree/main/integrations/opencode/inspector)
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
