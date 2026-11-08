/** One task's blame output, and the ranges each note points at. */

export const task = {
  key: "MDR-2",
  id: "01a1bb09-797e-73d6-aead-295f8f563adb",
};

export const fields = [
  { name: "Title", value: "Draft the release summary card", ref: "01a1bb09-797" },
  { name: "Column", value: "In Progress", ref: "01a1bb09-797" },
  { name: "Priority", value: "High", ref: "01a1bb09-797" },
  { name: "Due", value: "none", ref: "01a1bb09-797" },
  { name: "Labels", value: "review", ref: "01a1bb09-797" },
  { name: "Parent", value: "none", ref: "01a1bb09-797" },
];

export const description = [
  { line: "1", ref: "01a1bb09-797", text: "Summaries reach the board in one pass." },
  { line: "2", ref: "01a1bb09-79a", text: "Add the changelog link at the end." },
  { line: "3", ref: "01a1bb09-797", text: "Keep the byte count under 300." },
];

export const credits = [
  {
    ref: "01a1bb09-797",
    time: "2026-11-07 09:22:10.750 +01:00",
    name: "Helly R.",
    kind: "human",
    email: "helly.r@lumon.industries",
    source: "git-config",
    session: "null",
    thread: "null",
    agent: "null",
    model: "null",
    effort: "null",
    client: "zinn-cli/0.44.0",
  },
  {
    ref: "01a1bb09-79a",
    time: "2026-11-07 09:31:48.882 +01:00",
    name: "claude-code",
    kind: "agent",
    email: "null",
    source: "env:CLAUDECODE",
    session: "ses_01a1bb09-7c4f2e",
    thread: "null",
    agent: "claude-code",
    model: "opus-4.5",
    effort: "null",
    client: "zinn-cli/0.44.0 zinn-claude-code/0.2.0",
  },
];

export const outputLines = [
  `${task.key} (${task.id})`,
  "",
  "Fields:",
  ...fields.map((field) => `${field.name}: ${field.value} [${field.ref}]`),
  "",
  "Description:",
  ...description.map((row) => `${row.line} | [${row.ref}] | ${row.text}`),
  "",
  "Attribution:",
  ...credits.flatMap((credit) => [
    credit.ref,
    credit.time,
    credit.name,
    `Kind: ${credit.kind}`,
    `Email: ${credit.email}`,
    `Source: ${credit.source}`,
    `Session: ${credit.session}`,
    `Thread: ${credit.thread}`,
    `Agent: ${credit.agent}`,
    `Model: ${credit.model}`,
    `Effort: ${credit.effort}`,
    `Client: ${credit.client}`,
    "",
  ]),
];

export type RegionId = "fields" | "agentLine" | "client";

export interface Range {
  /** Inclusive line indices into `outputLines`. */
  start: number;
  end: number;
}

export interface Region extends Range {
  id: RegionId;
  /** Further ranges the same note points at, such as the event a set of fields references. */
  also?: Array<Range>;
}

export interface Note {
  id: RegionId;
  number: string;
  /** The line or block the note points at. */
  label: string;
  body: string;
}

const agentLine = description[1]!;
const agentCredit = credits[1]!;
const fieldsStart = outputLines.indexOf("Fields:");
const descriptionStart = outputLines.indexOf("Description:");
const agentLineIndex = outputLines.findIndex((line) =>
  line.startsWith(`${agentLine.line} | [${agentLine.ref}]`),
);

/** One actor's block of the Attribution section, from its event id to its client line. */
function creditRange(credit: (typeof credits)[number]): Range {
  const start = outputLines.indexOf(credit.ref);
  const end = outputLines.findIndex((line, index) => index > start && line.startsWith("Client:"));

  if (start < 0 || end < 0) {
    throw new Error("A credit block no longer matches the output.");
  }

  return { start, end };
}

const firstCredit = creditRange(credits[0]!);
const secondCredit = creditRange(credits[1]!);

if (fieldsStart < 0 || descriptionStart < 0 || agentLineIndex < 0) {
  throw new Error("A blame note no longer points at a line of the output.");
}

export const regions: Array<Region> = [
  // The fields and the creation event every field references.
  { id: "fields", start: fieldsStart, end: descriptionStart - 2, also: [firstCredit] },
  { id: "agentLine", start: agentLineIndex, end: agentLineIndex },
  // The event behind the agent's line: actor, session, model and client chain.
  { id: "client", start: secondCredit.start, end: secondCredit.end },
];

export const notes: Array<Note> = [
  {
    id: "fields",
    number: "01",
    label: "Fields:",
    body: "Every field carries the event that last set it, and the event is the block named below.",
  },
  {
    id: "agentLine",
    number: "02",
    label: `${agentLine.line} | [${agentLine.ref}] | ${agentLine.text}`,
    body: "One line, replaced by an agent. The lines around it keep the event that created them.",
  },
  {
    id: "client",
    number: "03",
    label: `Client: ${agentCredit.client}`,
    body: "The event behind that line: the agent, its session and model, and the chain of programs that made the change.",
  },
];

/** How many lines either side of a focused range stay at the middle weight. */
const NEAR_LINES = 2;

/** Every range a note lights, in output order. */
export function rangesOf(region: Region): Array<Range> {
  return [{ start: region.start, end: region.end }, ...(region.also ?? [])];
}

/**
 * Sets `data-state` on every line of a panel: `focus` inside a range,
 * `near` within NEAR_LINES of one, `far` for the rest.
 */
export function paint(panel: HTMLElement, active: RegionId | null) {
  const region = active === null ? undefined : regions.find((entry) => entry.id === active);
  const ranges = region === undefined ? [] : rangesOf(region);

  for (const line of panel.querySelectorAll<HTMLElement>("[data-line]")) {
    if (region === undefined) {
      delete line.dataset.state;
      continue;
    }

    const index = Number(line.dataset.line);
    const distance = Math.min(
      ...ranges.map((range) =>
        index < range.start ? range.start - index : index > range.end ? index - range.end : 0,
      ),
    );

    line.dataset.state = distance === 0 ? "focus" : distance <= NEAR_LINES ? "near" : "far";
  }
}
