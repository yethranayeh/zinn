// Fixture store rows and sample texts shared by the transcript tests.
// No test here. Not a store: the tests never touch one (process.run is stubbed).

/** SAM-2 is a real key beside SAM-27, so a SAM-2 caught mid-stream would draw a wrong title. */
export const ROWS = [
  { key: 'SAM-27', status: 'Active', column: 'In Progress', title: 'Calibrate the `probe` | table *x* [y]' },
  { key: 'SAM-2', status: 'Active', column: 'Done', title: 'Old task two' },
  { key: 'ZCC-5', status: 'Active', column: 'Review', title: 'Spike: does rewriting AssistantMessage/UserMessage text draw key decorations in place?' },
  { key: 'ZCC-6', status: 'Active', column: 'In Progress', title: 'Build key-lines MVP: key decorations in the transcript, unknown keys flagged, /zinn refresh' },
  { key: 'ZCC-1', status: 'Archived', column: 'Done', title: 'Survey' },
  { key: 'ZCC-7', status: 'Active', column: 'Blocked', title: 'Keep the key map live' },
  { key: 'ZCC-8', status: 'Active', column: 'TODO', title: 'Task detail pane' },
]

/** A reply as a model writes one: bold, inline code, a list, a fence, an invented key, an echoed title. */
export const SAMPLE = [
  'Next I finish **ZCC-6**, then ZCC-8. ZCC-99 is not on the board.',
  '',
  '- check it with `zinn task view ZCC-6`',
  '- ZCC-7 waits on the pane',
  '- ZCC-5: Spike: does rewriting AssistantMessage text draw…',
  '',
  '```sh',
  'zinn task move ZCC-8 "In Progress"',
  '```',
].join('\n')

/** What the sample's decorations must say with colour off, per key: [key, mark (shapes), mark (words)]. */
export const SAMPLE_KNOWN: readonly [string, string, string][] = [
  ['ZCC-6', '◐', 'in progress'],
  ['ZCC-8', '○', 'todo'],
  ['ZCC-7', '⊘', 'blocked'],
  ['ZCC-5', '◑', 'review'],
]
export const SAMPLE_UNKNOWN: readonly string[] = ['ZCC-99']

export const PROMPT = 'can you pick up ZCC-8 after ZCC-6? and what is ZCC-42'
