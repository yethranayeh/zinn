import { getRelease, npmPackageUrl } from "../config/releases";

// HTML-only elements are omitted from the twin. An aside keeps its label as a quoted note.
// Release wrappers expand back to the release heading and package line.
export function markdownBody(body: string) {
  return body
    .replace(/^import AgentSetup from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^import Aside from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^import ChangelogIntro from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^import Release from ["'][^"']+["'];\r?\n/m, "")
    .replace(/^\r?\n/, "")
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
    .replace(/^<ChangelogIntro>[ \t]*\r?\n(?:\r?\n)?/gm, "")
    .replace(/^<\/ChangelogIntro>[ \t]*\r?\n(?:\r?\n)?/gm, "")
    .replace(
      /^<Release version="([^"]+)"(?: first)?>[ \t]*\r?\n(?:\r?\n)?/gm,
      (_match, version: string) => {
        const release = getRelease(version);
        const name = release.name ? ` ${release.name}` : "";
        const packages = `[CLI ${release.cli}](${npmPackageUrl("cli", release.cli)}) | [Core ${release.core}](${npmPackageUrl("core", release.core)})`;

        return `## ${release.version}${name} - ${release.date}\n\n${packages}\n\n`;
      },
    )
    .replace(/^<\/Release>[ \t]*(?:\r?\n(?:\r?\n)?|$)/gm, "")
    .trim();
}
