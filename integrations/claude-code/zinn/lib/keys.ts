// The key map and the mentions in a block of text, with a project filter. Keys inside code are skipped.
// Pure: nothing here imports the engine module.
//
// Anchoring: the pattern below only PROPOSES
// candidates. A candidate is decorated only when the store has the key. A candidate whose project
// is in the store but whose number is not is flagged as unknown (the hallucination tripwire). A
// candidate whose project is not in the store at all (UTF-8, SHA-256, GPT-4) is left alone: flagging
// those would teach the eye to ignore the flag. The cost: a hallucinated *project*
// (FOO-12 with no FOO board) is not caught.

/** One task as `zinn task list --all --json` prints it (0.37.0. Same shape at 0.39.0). Only the fields read here. */
export type ZinnTaskRow = {
  key: string
  status?: string // 'Active' | 'Archived' (lifecycle, not the board column)
  column?: string // the board column: the status a person means
  title?: string
}

export type KeyInfo = { key: string; column: string; title: string; isArchived: boolean }

export type KeyMap = {
  keys: ReadonlyMap<string, KeyInfo>
  projects: ReadonlySet<string>
  archived: number
}

export const projectOf = (key: string): string => key.slice(0, key.lastIndexOf('-'))

/** Parses the CLI's JSON. Throws with a short reason on anything that is not an array of rows. */
export function parseTaskList(stdout: string): KeyMap {
  const data: unknown = JSON.parse(stdout)
  if (!Array.isArray(data)) {
    throw new Error(`expected a JSON array, got ${typeof data}`)
  }
  const keys = new Map<string, KeyInfo>()
  const projects = new Set<string>()
  let archived = 0
  for (const row of data as unknown[]) {
    if (typeof row !== 'object' || row === null) {
      continue
    }
    const r = row as ZinnTaskRow
    if (typeof r.key !== 'string' || !KEY_EXACT.test(r.key)) {
      continue
    }
    const isArchived = r.status === 'Archived'
    if (isArchived) {
      archived++
    }
    keys.set(r.key, { key: r.key, column: typeof r.column === 'string' ? r.column : '', title: typeof r.title === 'string' ? r.title : '', isArchived })
    projects.add(projectOf(r.key))
  }
  return { keys, projects, archived }
}

/** A key as Zinn spells it: project (letters/digits, starts with a letter), dash, number. Upper case only. */
const KEY_SOURCE = '[A-Z][A-Z0-9]{0,15}-[0-9]{1,6}'
const KEY_EXACT = new RegExp(`^${KEY_SOURCE}$`)
// Not after a letter, digit, `_`, `-`, `.`, `#`, `=`, `@` or `\` (slugs, versions, anchors, query strings).
// Not before a letter/digit/`_`, a `-word` (a slug: 2026-10-09-ABC-5-rewrite) or a `.ext` (ABC-5.md).
// `/` is allowed on both sides on purpose: "ABC-5/ABC-6" is common prose; URLs are caught below.
const KEY_IN_TEXT = new RegExp(`(?<![A-Za-z0-9_\\-.#=@\\\\])(${KEY_SOURCE})(?![A-Za-z0-9_]|-[A-Za-z0-9]|\\.[A-Za-z0-9])`, 'g')

export type Where = 'prose' | 'inline-code' | 'fence'

export type Mention = {
  key: string
  start: number
  end: number
  /** Where a suffix goes: after the key, or past a closing emphasis, a link's `](...)`, a possessive `'s`. */
  anchor: number
  kind: 'known' | 'unknown'
  info: KeyInfo | null
  where: Where
  /** For inline code: the offset just past the closing backticks. */
  spanEnd: number | null
  /** The first mention of this key in the block. */
  isFirst: boolean
  /** The key touches the end of the text (only emphasis/backticks after it): it may still be growing. */
  isTail: boolean
}

type Range = { start: number; end: number; where: Where; spanEnd: number | null }

/** Fenced blocks (``` or ~~~, CommonMark-style open/close) and inline code spans, per line. */
export function codeRanges(text: string): Range[] {
  const out: Range[] = []
  let offset = 0
  let fence: { ch: string; len: number; start: number } | null = null
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && line.trim() === m[1]) {
        out.push({ start: fence.start, end: lineEnd, where: 'fence', spanEnd: null })
        fence = null
      }
    } else if (m) {
      fence = { ch: m[1]![0]!, len: m[1]!.length, start: offset }
    } else {
      // inline spans: a run of n backticks opens, the next run of exactly n closes
      const runs = [...line.matchAll(/`+/g)]
      for (let i = 0; i < runs.length; i++) {
        const open = runs[i]!
        const close = runs.slice(i + 1).find(r => r[0].length === open[0].length)
        if (!close) {
          continue
        }
        out.push({ start: offset + open.index!, end: offset + close.index! + close[0].length, where: 'inline-code', spanEnd: offset + close.index! + close[0].length })
        i = runs.indexOf(close)
      }
    }
    offset = lineEnd + 1
  }
  // An unclosed fence (mid-stream) runs to the end of the text.
  if (fence !== null) {
    out.push({ start: fence.start, end: text.length, where: 'fence', spanEnd: null })
  }
  return out
}

/**
 * The whitespace-delimited run around [start, end): a URL when it holds `://` or starts with `www.`.
 * A Markdown link `[label](target)` is cut at `](` first, so a key used as the label of a link
 * (`[ABC-6](https://…)`) is judged by its label part alone, and a key inside the target still counts
 * as a URL.
 */
function isInUrl(text: string, start: number, end: number): boolean {
  let a = start
  while (a > 0 && !/\s/.test(text[a - 1]!)) a--
  let b = end
  while (b < text.length && !/\s/.test(text[b]!)) b++
  const before = text.lastIndexOf('](', start)
  if (before >= a) {
    a = before + 2
  }
  const after = text.indexOf('](', end)
  if (after !== -1 && after < b) {
    b = after
  }
  const run = text.slice(a, b)
  return run.includes('://') || /^[(<[]*www\./.test(run)
}

/** Moves a suffix past what would otherwise swallow it: `**KEY**`, `[KEY](url)`, `KEY's`. */
function anchorAfter(text: string, end: number): number {
  let i = end
  const poss = /^['\u2019]s\b/.exec(text.slice(i))
  if (poss) {
    i += poss[0].length
  }
  const emph = /^[*_~]+/.exec(text.slice(i))
  if (emph) {
    i += emph[0].length
  }
  const link = /^\]\([^)\s]*\)/.exec(text.slice(i))
  if (link) {
    i += link[0].length
  }
  return i
}

/**
 * What happens to a key inside code.
 * - `skip`: never decorated or flagged in code (inline or fenced).
 * - `after-span`: inline code keeps its text. The suffix goes after the closing backticks. Fences: skipped.
 * - `inside`: the naive rewrite: the suffix goes right after the key, inside the code (fences too).
 */
export type CodePolicy = 'skip' | 'after-span' | 'inside'
export const CODE_POLICIES: readonly CodePolicy[] = ['skip', 'after-span', 'inside']

/**
 * `only`: the projects to decorate (null = every project in the store). A key of a project outside it is
 * left alone entirely: neither decorated nor flagged.
 */
export type FindOptions = { repeat: 'first' | 'every'; code: CodePolicy; only?: ReadonlySet<string> | null }
/** Keys inside code are skipped. */
export const DEFAULT_FIND: FindOptions = { repeat: 'first', code: 'skip', only: null }

/** Every key-shaped token the map can judge: known keys, and unknown keys of a known project. */
export function findMentions(text: string, map: KeyMap, opts: FindOptions = DEFAULT_FIND): Mention[] {
  const ranges = codeRanges(text)
  const out: Mention[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(KEY_IN_TEXT)) {
    const key = m[1]!
    const start = m.index!
    const end = start + key.length
    const info = map.keys.get(key) ?? null
    const project = projectOf(key)
    if (info === null && !map.projects.has(project)) {
      continue
    }
    if (opts.only && !opts.only.has(project)) {
      continue
    }
    if (isInUrl(text, start, end)) {
      continue
    }
    const r = ranges.find(x => start >= x.start && end <= x.end)
    const where: Where = r ? r.where : 'prose'
    if (where !== 'prose' && opts.code === 'skip') {
      continue
    }
    if (where === 'fence' && opts.code === 'after-span') {
      continue
    }
    const isFirst = !seen.has(key)
    seen.add(key)
    if (!isFirst && opts.repeat === 'first') {
      continue
    }
    const isTail = /^[*_~`]*$/.test(text.slice(end))
    const spanEnd = r ? r.spanEnd : null
    const anchor = where === 'prose' ? anchorAfter(text, end) : where === 'inline-code' && opts.code === 'after-span' && spanEnd !== null ? spanEnd : end
    out.push({ key, start, end, anchor, kind: info ? 'known' : 'unknown', info, where, spanEnd, isFirst, isTail })
  }
  return out
}
