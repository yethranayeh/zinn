// The options (userConfig) and the environment variables that may stand in for them. Pure.
//
// Why environment variables: a /config change writes `pluginConfigs` into the user settings. To try a look
// for one session, the launch command sets ZINN_MENTIONS_LOOK and friends instead. An option left at
// `from-env` reads them.
import { parsePollSeconds } from './watch'

/**
 * How a decoration looks. Named by what is on screen:
 * - `suffix`:   ` · ◐ title` after the key, in the reply's own text colour. The reply's formatting is the engine's.
 * - `brackets`: ` [◐ title]` after the key: the same, with the end of the decoration marked.
 * - `colour`:   the suffix's characters, with the key bold, the status mark coloured and the title dim.
 *               Paragraphs holding a key are drawn by the mod, keeping bold, italics, code and list markers.
 * - `under`:    the reply untouched. One dim line under it lists each key with its mark and title.
 * - `off`:      nothing drawn.
 */
export type Look = 'suffix' | 'brackets' | 'colour' | 'under' | 'off'
export const LOOKS: readonly Look[] = ['suffix', 'brackets', 'colour', 'under', 'off']
export const DEFAULT_LOOK: Look = 'under'

/**
 * How the `under` look's line is laid out (the pieces are the same in every style):
 * - `spaced`:   `↳ KEY ◐ title   KEY ○ title` (entries three spaces apart. The first style, no longer the default).
 * - `brackets`: `↳ [KEY ◐ title] [KEY ○ title]` (each entry closed in its own brackets).
 * - `dots`:     `↳ KEY ◐ title · KEY ○ title`.
 * - `stacked`:  one entry per line, each line starting `↳ `, keys padded to align. The default, for every count of tasks.
 */
export type Legend = 'spaced' | 'brackets' | 'dots' | 'stacked'
export const LEGENDS: readonly Legend[] = ['spaced', 'brackets', 'dots', 'stacked']
export const DEFAULT_LEGEND: Legend = 'stacked'

/**
 * Entries per legend block: at most this many entries are drawn, then one dim
 * `+N more` line. 0 = no cap. So is any value of NO_CAP_FROM or more. Applies to every legend style.
 */
export const DEFAULT_MAX_ENTRIES = 5
export const NO_CAP_FROM = 1000

/** The cap from an option or a variable: whole number >= 0, or null when it is absent or not a number. */
export function parseMaxEntries(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0) {
    return null
  }
  return n >= NO_CAP_FROM ? 0 : Math.floor(n)
}

/**
 * What a press on a key of the stacked `under` legend does.
 * - `button`: the key is a plain Button, and a press opens the pane on that task. The default.
 * - `link`:   the key is a Markdown link `[KEY](https://zinn.invalid/KEY)` with `onLinkPress`. The same press.
 *             The href is a placeholder (only https/http/file draw as links), so a ctrl-click opens a dead
 *             URL. Both press only where the surface reports clicks (fullscreen).
 * - `off`:    nothing is pressable.
 */
export type KeyPress = 'off' | 'button' | 'link'
export const KEY_PRESSES: readonly KeyPress[] = ['off', 'button', 'link']
export const DEFAULT_KEY_PRESS: KeyPress = 'button'

/**
 * What is pinned under the prompt (`$.ui.status`). The engine draws that line beside its own pinned notices,
 * with a warning mark, so a line that is always there reads as a fault.
 * - `problems`: a line only while something is wrong (no key map, RESTART NEEDED, the log failed). The default.
 * - `always`:   the look, the key count and the timing, at all times.
 * - `off`:      never a line. A fault then shows on the footer label alone.
 */
export type StatusLine = 'problems' | 'always' | 'off'
export const STATUS_LINES: readonly StatusLine[] = ['problems', 'always', 'off']
export const DEFAULT_STATUS_LINE: StatusLine = 'problems'

/** The person's own prompts are left as typed unless asked. */
export const DEFAULT_MY_PROMPTS = 'leave'

/** The status mark: `shapes` (○ ◐ ◑ ⊘ ●, ▪ archived) or `words` (todo, in progress, review, ...). */
export type Marks = 'shapes' | 'words'
export const MARKS: readonly Marks[] = ['shapes', 'words']

export type Config = {
  enabled: boolean
  look: Look
  lookSource: string
  /** The `under` look's line layout. */
  legend: Legend
  /** Entries per legend block. 0 = no cap. */
  maxEntries: number
  /** What a press on a legend key does (stacked legend only). */
  keyPress: KeyPress
  marks: Marks
  /** Characters of title shown (an ellipsis counts as one). 0 shows the mark only. */
  titleMax: number
  /** Projects to decorate, upper case. Null = every project in the store. */
  only: ReadonlySet<string> | null
  /** Decorate the person's own prompts (UserMessage) too. Default false (leave them as typed). */
  myPrompts: boolean
  /** AssistantMessage only: a key touching the end of a streaming block waits this long. 0 = off. */
  tailGuardMs: number
  /** Write the timing log (counts and timings only) to `logDir`. */
  log: boolean
  /** Absolute folder for the log. '' takes the default, `<home>/.zinn/traces/zinn`. */
  logDir: string
  /** Seconds between change checks on the activity log. 0 = no timer. */
  pollSeconds: number
  /** A toast when a decorated key changes column mid-session. */
  toastOnChange: boolean
  /** When a line is pinned under the prompt. */
  statusLine: StatusLine
  /** One dim `zinn` among the mode labels at the right of the prompt footer: the sign that the mod is loaded. */
  footerLabel: boolean
  /** The footer label names the task this session holds. */
  footerClaim: boolean
  /** A toast before this session's claim runs out and when it has, and a notice at session end naming claims still held. */
  claimNotices: boolean
  /** After a main-loop turn that ran a tool, renew this session's claims that have less than half their lease left. */
  renewClaims: boolean
}

export type EnvReads = { look?: string; legend?: string; maxEntries?: string; keyPress?: string; marks?: string; myPrompts?: string; log?: string; statusLine?: string }

const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '')

function pick<T extends string>(option: unknown, env: string | undefined, allowed: readonly T[], fallback: T, envName: string): { value: T; source: string } {
  const opt = lower(option)
  if (opt !== '' && opt !== 'from-env' && (allowed as readonly string[]).includes(opt)) {
    return { value: opt as T, source: 'userConfig' }
  }
  const e = lower(env)
  if ((allowed as readonly string[]).includes(e)) {
    return { value: e as T, source: envName }
  }
  if (e !== '') {
    return { value: fallback, source: `default (${envName}="${e.slice(0, 20)}" is not one of ${allowed.join('/')})` }
  }
  return { value: fallback, source: 'default' }
}

/** `ABC, xyz ,DEF` -> {ABC, XYZ, DEF}. Empty or `*` -> null (all). */
export function parseProjects(v: unknown): ReadonlySet<string> | null {
  const raw = typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : ''
  const keys = raw.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(s => /^[A-Z][A-Z0-9]{0,15}$/.test(s))
  if (keys.length === 0 || raw.trim() === '*') {
    return null
  }
  return new Set(keys)
}

export function parseConfig(options: Readonly<Record<string, unknown>>, env: EnvReads): Config {
  const look = pick(options['look'], env.look, LOOKS, DEFAULT_LOOK, 'ZINN_MENTIONS_LOOK')
  const legend = pick(options['legend'], env.legend, LEGENDS, DEFAULT_LEGEND, 'ZINN_MENTIONS_LEGEND')
  const keyPress = pick(options['keyPress'], env.keyPress, KEY_PRESSES, DEFAULT_KEY_PRESS, 'ZINN_MENTIONS_KEY_PRESS')
  const marks = pick(options['marks'], env.marks, MARKS, 'shapes', 'ZINN_MENTIONS_MARKS')
  const prompts = pick(options['myPrompts'], env.myPrompts, ['decorate', 'leave'] as const, DEFAULT_MY_PROMPTS, 'ZINN_MENTIONS_MY_PROMPTS')
  const statusLine = pick(options['statusLine'], env.statusLine, STATUS_LINES, DEFAULT_STATUS_LINE, 'ZINN_MENTIONS_STATUS_LINE')
  const t = options['titleLength']
  const g = options['tailGuardMs']
  const logEnv = lower(env.log)
  return {
    enabled: options['enabled'] !== false,
    look: look.value,
    lookSource: look.source,
    legend: legend.value,
    maxEntries: parseMaxEntries(options['maxEntries']) ?? parseMaxEntries(env.maxEntries) ?? DEFAULT_MAX_ENTRIES,
    keyPress: keyPress.value,
    marks: marks.value,
    titleMax: typeof t === 'number' && Number.isFinite(t) && t >= 0 ? Math.min(Math.floor(t), 200) : 40,
    only: parseProjects(options['projects']),
    myPrompts: prompts.value === 'decorate',
    tailGuardMs: typeof g === 'number' && Number.isFinite(g) && g >= 0 ? g : 400,
    log: options['log'] === true || logEnv === '1' || logEnv === 'true' || logEnv === 'on',
    logDir: typeof options['logDir'] === 'string' ? options['logDir'].trim() : '',
    pollSeconds: parsePollSeconds(options['pollSeconds']),
    toastOnChange: options['toastOnChange'] !== false,
    statusLine: statusLine.value,
    footerLabel: options['footerLabel'] !== false,
    footerClaim: options['footerClaim'] !== false,
    claimNotices: options['claimNotices'] !== false,
    renewClaims: options['renewClaims'] !== false,
  }
}
