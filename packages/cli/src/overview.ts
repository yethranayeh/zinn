// What Zinn can do, shown in the top-level help. Each use names a command and the flags that do the job.
type OverviewUse = { command: string; flags?: Array<string> };

export const overview: Array<{ summary: string; uses: Array<OverviewUse> }> = [
  {
    summary: "Set deadlines and sort or filter by them",
    uses: [
      { command: "task create", flags: ["--due"] },
      { command: "task edit", flags: ["--due"] },
      { command: "task list", flags: ["--sort due", "--due-since", "--due-until"] },
    ],
  },
  {
    summary: "Change several tasks in one command",
    uses: [{ command: "task move" }, { command: "task archive" }, { command: "task delete" }],
  },
  {
    summary: "Read text from a file or stdin",
    uses: [
      { command: "task create", flags: ["--description-file"] },
      { command: "task comment create", flags: ["--text-file"] },
    ],
  },
  { summary: "Search titles, descriptions and comments", uses: [{ command: "task search" }] },
  {
    summary: "Continue a long list",
    uses: [
      { command: "task list", flags: ["--limit", "--starting-after"] },
      { command: "activity list", flags: ["--limit", "--starting-after"] },
    ],
  },
  {
    summary: "See the agent and session behind each change",
    uses: [{ command: "activity list" }, { command: "activity view" }],
  },
];

export function formatOverview() {
  return overview
    .map(({ summary, uses }) => {
      const named = uses.map(({ command, flags = [] }) => [command, ...flags].join(" "));
      return `  ${summary}: ${named.join(", ")}`;
    })
    .join("\n");
}
