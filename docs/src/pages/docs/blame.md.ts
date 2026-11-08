import type { APIRoute } from "astro";

import { notes, outputLines } from "../../components/blame/example";

const intro =
  "The whole task, attributed. Every field and description line with recorded history points at the edit that set it, and the edit names the person or program behind it.";

const noteList = notes
  .map((note) => `- **${note.number}** \`${note.label}\` ${note.body}`)
  .join("\n");

const rules = [
  [
    "Whole lines, matched exactly",
    "Description attribution compares complete lines, whitespace included. Blank lines are preserved.",
  ],
  [
    "Shared lines keep their event",
    "Lines the edit leaves alone keep their attribution. Lines it introduces belong to the edit.",
  ],
  [
    "Missing history reads as unrecorded",
    "A field or line without a recorded origin prints as unrecorded rather than guessing.",
  ],
  [
    "Archived tasks still answer",
    "Blame reads active and archived tasks, and records no activity of its own.",
  ],
]
  .map(([heading, body]) => `### ${heading}\n\n${body}`)
  .join("\n\n");

export const GET: APIRoute = () =>
  new Response(
    `# Task blame

${intro}

\`\`\`sh
zinn task blame MDR-2
zinn task blame MDR-2 --json
\`\`\`

\`\`\`text
${outputLines.join("\n")}
\`\`\`

${noteList}

## How it decides

${rules}

Gaps and mismatched history can leave lines unrecorded. The full rules, including comparison edge cases, are in the [CLI reference](https://zinn.sh/docs/cli#task-blame).

## JSON

With \`--json\`, the command returns the [\`TaskBlame\` result](https://zinn.sh/docs/core#task-blame-result). Each reference opens with \`zinn activity view <activity-id>\`.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
