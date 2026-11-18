// What to draw for one message, as plain data. Pure.
//
// One plan feeds two consumers, so they cannot drift apart:
// - hooks/mentions.tsx turns it into the engine's props or elements (the only version-bound step).
// - lib/paint.ts turns it into terminal text at a colour depth (the colour test).
import type { KeyMap, Mention } from './keys'
import { findMentions } from './keys'
import { DEFAULT_LEGEND, DEFAULT_MAX_ENTRIES, type Config, type Legend, type Look } from './config'
import { decoFor, markAndTitle, rewriteText, SEPARATOR, UNKNOWN_MARK, type Deco } from './decorate'
import { drawBlock, drawPlain } from './markdown'
import { DIM, KEY_STYLE, pushSpan, UNKNOWN_KEY_STYLE, UNKNOWN_MARK_STYLE, type Span } from './style'

export type PlanBlock = { t: 'md'; text: string } | { t: 'spans'; lines: Span[][] }

export type Plan =
  | { kind: 'pass' }
  /** Hand the engine this text in place of the message's (it draws it as it would the original). */
  | { kind: 'rewrite'; text: string }
  /** The mod's own tree: Markdown blocks the engine draws, and span blocks the mod draws. */
  | { kind: 'own'; blocks: PlanBlock[]; fallbacks: number }
  /** The engine's own drawing, untouched, then the legend under it: one line, or one per key when `stacked`. */
  | { kind: 'under'; lines: Span[][]; keys: (string | null)[] }

export type Block = { start: number; end: number; text: string; isFence: boolean }

/** The text cut at blank lines outside fences. A fence is one block. */
export function toBlocks(text: string): Block[] {
  const out: Block[] = []
  let offset = 0
  let cur: { start: number; isFence: boolean } | null = null
  let fence: { ch: string; len: number } | null = null
  const close = (end: number): void => {
    if (cur !== null) {
      out.push({ start: cur.start, end, text: text.slice(cur.start, end), isFence: cur.isFence })
    }
    cur = null
  }
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && line.trim() === m[1]) { fence = null; close(lineEnd) }
    } else if (m) {
      close(Math.max(offset - 1, 0))
      fence = { ch: m[1]![0]!, len: m[1]!.length }
      cur = { start: offset, isFence: true }
    } else if (line.trim() === '') {
      close(Math.max(offset - 1, 0))
    } else if (cur === null) {
      cur = { start: offset, isFence: false }
    }
    offset = lineEnd + 1
  }
  close(text.length)
  return out.filter(b => b.text.trim() !== '')
}

/** The decoration's spans for the `colour` look: the same characters as `suffix`, styled. */
export function colourSpans(d: Deco, marks: Config['marks']): Span[] {
  const out: Span[] = []
  pushSpan(out, SEPARATOR, DIM)
  if (d.kind === 'unknown') { pushSpan(out, UNKNOWN_MARK, UNKNOWN_MARK_STYLE); return out }
  pushSpan(out, d.mark, d.color ? { color: d.color } : DIM)
  if (d.title !== null) {
    pushSpan(out, markAndTitle('', d.title, marks), DIM)
  }
  return out
}

/**
 * Columns the `under` legend is indented: the width of the reply's bullet and its space (`● `). The engine
 * declares the bullet (`isFirstOfReply`) but no indent; reply text, bulleted or not, is seen to start at
 * column 2. hooks/mentions.tsx puts it on the legend's Box as `paddingLeft`, so wrapped continuation lines
 * start there too.
 */
export const UNDER_INDENT = 2

/**
 * One key's entry in the legend: `KEY ◐ title`, or `KEY ✗ not in Zinn`. Styles as in every look.
 * `pad` spaces follow the key (stacked alignment); they carry no style.
 */
function entrySpans(text: string, m: Mention, cfg: Pick<Config, 'marks' | 'titleMax'>, pad = 0): Span[] {
  const out: Span[] = []
  const d = decoFor(text, m, cfg, true) // the legend always carries the title
  const gap = ' '.repeat(pad)
  if (d.kind === 'unknown') {
    pushSpan(out, m.key, UNKNOWN_KEY_STYLE)
    if (pad > 0) {
      pushSpan(out, gap, {})
    }
    pushSpan(out, ' ' + UNKNOWN_MARK, UNKNOWN_MARK_STYLE)
    return out
  }
  pushSpan(out, m.key, KEY_STYLE)
  pushSpan(out, gap + ' ', {})
  pushSpan(out, d.mark, d.color ? { color: d.color } : DIM)
  if (d.title !== null) {
    pushSpan(out, markAndTitle('', d.title, cfg.marks), DIM)
  }
  return out
}

/** Width of the KEY-000 floor, used when a key cannot be measured by its length (see keyWidth). */
export const KEY_FLOOR_WIDTH = 7

/**
 * The column width the keys of one block are padded to. Keys are ASCII (`^[A-Z][A-Z0-9]*-\d+$`, lib/keys.ts),
 * so string length is display width, and the width is the longest key in the block.
 * If a key were not plain ASCII (it cannot be today), length would not be display width: fall back to
 * the fixed floor KEY_FLOOR_WIDTH (`KEY-000`).
 */
export function keyWidth(keys: readonly string[]): number {
  if (keys.some(k => !/^[\x21-\x7e]+$/.test(k))) {
    return Math.max(KEY_FLOOR_WIDTH, ...keys.map(k => [...k].length))
  }
  return Math.max(0, ...keys.map(k => k.length))
}

/** How many unknown keys the overflow row names before it counts the rest as `+M unknown`. */
export const UNKNOWN_ON_OVERFLOW = 5

/** Which mentions the legend shows: each key once in order of first mention, capped as `underLines` says. */
function selectEntries(mentions: readonly Mention[], maxEntries: number): { shown: Mention[]; moreKnown: number; tailUnknown: Mention[] } {
  const seen = new Set<string>()
  const list: Mention[] = []
  for (const m of mentions) {
    if (seen.has(m.key)) {
      continue
    }
    seen.add(m.key)
    list.push(m)
  }
  let shown = list
  let moreKnown = 0
  let tailUnknown: Mention[] = []
  if (maxEntries > 0 && list.length > maxEntries) {
    const known = list.filter(m => m.kind !== 'unknown')
    shown = known.slice(0, maxEntries)
    moreKnown = known.length - shown.length
    tailUnknown = list.filter(m => m.kind === 'unknown')
  }
  return { shown, moreKnown, tailUnknown }
}

/**
 * The key a press on each legend line opens, parallel to `underLines`: only the stacked legend has one
 * key per line, so any other legend gives none. The overflow row and a key the store lacks are `null`.
 * Contract with `underLines`: a stacked line's spans are `['↳ ', KEY, ...rest]`, the key always its own span.
 */
export function underKeys(mentions: readonly Mention[], legend: Legend = DEFAULT_LEGEND, maxEntries: number = DEFAULT_MAX_ENTRIES): (string | null)[] {
  if (legend !== 'stacked') {
    return []
  }
  const { shown, moreKnown, tailUnknown } = selectEntries(mentions, maxEntries)
  const out: (string | null)[] = shown.map(m => (m.kind === 'unknown' ? null : m.key))
  if (moreKnown > 0 || tailUnknown.length > 0) {
    out.push(null)
  }
  return out
}

/**
 * The `under` look's legend, one entry per key in order of first mention, as lines of spans. Every style
 * starts with a dim `↳ `; `stacked` has one line per entry (each starting `↳ `, so a line stands alone
 * when copied or wrapped, keys padded with spaces to the longest key shown), the others one line.
 *
 * Cap (`maxEntries`, 0 = none) counts VALID (known) keys only, so unknown keys never push
 * valid tasks out. If known + unknown fit in the cap, everything is shown in reply order, unknown keys in
 * place, no overflow row. If not: the first `maxEntries` known keys are shown in the chosen style, then one
 * trailing row (a second line in the one-line styles): `↳ +N more | KEY ✗ not in Zinn | … | +M unknown`.
 * Parts appear only when they apply; the separator ` | ` is dim; unknown entries keep the unknown style;
 * at most UNKNOWN_ON_OVERFLOW unknown entries are named, `+M unknown` counts the rest, so none is dropped
 * silently. Replaces the earlier rule (unknown keys took slots first, the cap grew to fit them).
 */
export function underLines(text: string, mentions: readonly Mention[], cfg: Pick<Config, 'marks' | 'titleMax'>, legend: Legend = DEFAULT_LEGEND, maxEntries: number = DEFAULT_MAX_ENTRIES): Span[][] {
  const { shown, moreKnown, tailUnknown } = selectEntries(mentions, maxEntries)
  const width = legend === 'stacked' ? keyWidth(shown.map(m => m.key)) : 0
  const entries = shown.map(m => entrySpans(text, m, cfg, legend === 'stacked' ? width - m.key.length : 0))
  const lead = (line: Span[]): void => pushSpan(line, '↳ ', DIM)
  const out: Span[][] = []
  if (legend === 'stacked') {
    for (const e of entries) { const line: Span[] = []; lead(line); for (const sp of e) pushSpan(line, sp.s, sp.style); out.push(line) }
  } else {
    const line: Span[] = []
    lead(line)
    entries.forEach((e, i) => {
      if (i > 0) {
        if (legend === 'dots') {
          pushSpan(line, ' · ', DIM)
        } else {
          pushSpan(line, legend === 'brackets' ? ' ' : '   ', {})
        }
      }
      if (legend === 'brackets') {
        pushSpan(line, '[', DIM)
      }
      for (const sp of e) pushSpan(line, sp.s, sp.style)
      if (legend === 'brackets') {
        pushSpan(line, ']', DIM)
      }
    })
    out.push(line)
  }
  if (moreKnown > 0 || tailUnknown.length > 0) {
    const line: Span[] = []
    lead(line)
    let first = true
    const part = (spans: Span[]): void => {
      if (!first) {
        pushSpan(line, ' | ', DIM)
      }
      first = false
      for (const sp of spans) pushSpan(line, sp.s, sp.style)
    }
    if (moreKnown > 0) {
      part([{ s: `+${moreKnown} more`, style: DIM }])
    }
    for (const m of tailUnknown.slice(0, UNKNOWN_ON_OVERFLOW)) part(entrySpans(text, m, cfg))
    if (tailUnknown.length > UNKNOWN_ON_OVERFLOW) {
      part([{ s: `+${tailUnknown.length - UNKNOWN_ON_OVERFLOW} unknown`, style: UNKNOWN_MARK_STYLE }])
    }
    out.push(line)
  }
  return out
}

/** The `spaced` legend as one line (no cap): `↳ KEY ◐ title   KEY ✗ not in Zinn`. */
export function underLine(text: string, mentions: readonly Mention[], cfg: Pick<Config, 'marks' | 'titleMax'>): Span[] {
  return underLines(text, mentions, cfg, 'spaced', 0)[0]!
}

export type PlanInput = {
  text: string
  /** A reply block (Markdown) or a person's prompt (printable text). */
  markdown: boolean
  mentions: readonly Mention[]
  look: Look
  cfg: Pick<Config, 'marks' | 'titleMax'>
  /** The `under` look's layout; absent = `spaced`. */
  legend?: Legend
  /** Entries per legend block; absent = DEFAULT_MAX_ENTRIES, 0 = no cap. */
  maxEntries?: number
}

/** The plan for one message. `mentions` must come from `text`, in prose (keys in code are skipped). */
export function planFor(p: PlanInput): Plan {
  const { text, markdown, mentions, look, cfg, legend, maxEntries } = p
  if (look === 'off' || mentions.length === 0) {
    return { kind: 'pass' }
  }
  if (look === 'suffix' || look === 'brackets') {
    return { kind: 'rewrite', text: rewriteText(text, mentions, look, cfg, markdown) }
  }
  if (look === 'under') {
    return { kind: 'under', lines: underLines(text, mentions, cfg, legend, maxEntries), keys: underKeys(mentions, legend, maxEntries) }
  }
  // Decorations are decided on the whole text (the echo check reads around the key), then looked up by
  // key: the block drawer sees block-relative offsets. Deciding them on block offsets would repeat a title the
  // model had already written.
  const decided = new Map(mentions.map(m => [m.key, colourSpans(decoFor(text, m, cfg), cfg.marks)] as const))
  const deco = (m: Mention): Span[] => decided.get(m.key) ?? []
  const keyStyle = (m: Mention) => (m.kind === 'unknown' ? UNKNOWN_KEY_STYLE : KEY_STYLE)
  if (!markdown) {
    return { kind: 'own', blocks: [{ t: 'spans', lines: drawPlain(text, mentions, deco, keyStyle) }], fallbacks: 0 }
  }
  let fallbacks = 0
  const blocks: PlanBlock[] = toBlocks(text).map(b => {
    const own = mentions.filter(m => m.start >= b.start && m.end <= b.end).map(m => ({ ...m, start: m.start - b.start, end: m.end - b.start, anchor: m.anchor - b.start }))
    if (b.isFence || own.length === 0) {
      return { t: 'md', text: b.text }
    }
    const lines = drawBlock(b.text, own, deco, keyStyle)
    if (lines !== null) {
      return { t: 'spans', lines }
    }
    // A table, quote, link or nested list: left to the engine, still decorated (as text, no colour).
    fallbacks++
    return { t: 'md', text: rewriteText(b.text, own, 'suffix', cfg, true) }
  })
  return { kind: 'own', blocks, fallbacks }
}

/** Convenience for tests and the form: find, then plan. */
export function planText(text: string, map: KeyMap, cfg: Pick<Config, 'marks' | 'titleMax' | 'only'>, look: Look, markdown = true, tail: 'keep' | 'drop' = 'keep', legend: Legend = DEFAULT_LEGEND, maxEntries: number = DEFAULT_MAX_ENTRIES): Plan {
  let mentions = findMentions(text, map, { repeat: 'first', code: 'skip', only: cfg.only })
  if (tail === 'drop') {
    mentions = mentions.filter(m => !m.isTail)
  }
  return planFor({ text, markdown, mentions, look, cfg, legend, maxEntries })
}
