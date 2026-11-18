import { getTopicIndex } from "../components/docs/topic-index";

// HTML controls are omitted. Content indexes, notes and key labels keep their text.
export async function markdownBody(body: string, pageId: string) {
  const topicIndex = body.match(/<TopicIndex(?:\s+label=(["'])(.*?)\1)?\s*\/>/);
  if (topicIndex) {
    const topics = await getTopicIndex(pageId);
    const links = topics
      .map(({ title, path, headings }) =>
        [
          `- [${title}](${path})`,
          ...headings.map(({ text, slug }) => `  - [${text}](${path}#${slug})`),
        ].join("\n"),
      )
      .join("\n");
    body = body.replace(topicIndex[0], `## ${topicIndex[2] ?? "All topics"}\n\n${links}`);
  }
  return body
    .replace(/^import AgentSetup from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^import Aside from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^import Kbd from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^import TopicIndex from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^\r?\n/, "")
    .replace(/<Kbd\b[^>]*>([\s\S]*?)<\/Kbd>/g, (_match, label: string) => `\`${label.trim()}\``)
    .replace(/^<AgentSetup \/>\r?\n\r?\n/m, "")
    .replace(
      /^<Aside\b[^>]*label=(['"])(.+?)\1[^>]*>[ \t]*\r?\n\r?\n([\s\S]*?)\r?\n\r?\n<\/Aside>[ \t]*\r?\n[ \t]*\r?\n/gm,
      (_match, _quote, label: string, content: string) => {
        const quoted = content
          .split(/\r?\n/)
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n");
        return `> **${label}**\n>\n${quoted}\n\n`;
      },
    )
    .replace(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g, (match, path: string, fragment = "") => {
      if (path.split("/").at(-1)!.includes(".")) {
        return match;
      }
      const page = path.replace(/\/$/, "");
      return `](${page === "" ? "/index.md" : `${page}.md`}${fragment})`;
    });
}
