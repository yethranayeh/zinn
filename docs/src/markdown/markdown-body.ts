// HTML-only elements are omitted from the twin. An aside keeps its label as a quoted note, and a Kbd label becomes inline code.
export function markdownBody(body: string) {
  return body
    .replace(/^import AgentSetup from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^import Aside from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^import Kbd from ["'][^"']+["'];\r?\n/m, "")
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
    );
}
