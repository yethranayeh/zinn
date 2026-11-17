// A block of a reply drawn as styled spans, keeping the Markdown formatting the engine would have drawn.
// Pure.
//
// Why this exists: the engine's `Markdown` element takes no per-span style, so a key can only be coloured
// in a tree the mod draws itself, and a block the mod draws must look like the engine's own (no raw
// `**bold**` or backticks). So only the blocks that hold a key are drawn here, and only when they are of a kind
// this module draws faithfully. Every other block stays the engine's `Markdown`.
//
// What the engine draws, read from the 2.1.296 engine's Markdown renderer:
// `strong` bold, `em` italic, `del` strikethrough, `codespan` in the `permission` theme colour with the
// backticks gone, `heading` bold (depth 1: bold italic underline) with the `#`s gone, an unordered list
// item `- ` and an ordered one `N.`, a soft line break kept as a line break. Links, tables, quotes,
// nested lists and html are NOT redrawn here: a block holding one is left to the engine (the caller
// falls back to a plain text rewrite for it, so it is still decorated, without colour).
import type { Mention } from './keys'
import { pushSpan, type Span, type SpanStyle } from './style'

export type BlockKind = 'fence' | 'paragraph' | 'list' | 'heading' | 'complex'

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])( +)(?=\S)/
const HEADING = /^(#{1,6})[ \t]+/

/** What kind of block this is, and so whether this module may draw it. */
export function classify(block: string): BlockKind {
  const lines = block.split('\n')
  if (FENCE.test(lines[0] ?? '')) {
    return 'fence'
  }
  // Things this module does not redraw: tables, quotes, html, links/autolinks, indented code, nested lists, setext/hr.
  if (/(^|\n) {0,3}\|/.test(block) || /(^|\n) {0,3}>/.test(block)) {
    return 'complex'
  }
  if (/<[A-Za-z/!]/.test(block) || /\]\(|\]\[|:\/\/|(^|[\s(])www\./.test(block)) {
    return 'complex'
  }
  if (/(^|\n)( {4}|\t)/.test(block) && !LIST_ITEM.test(lines[0] ?? '')) {
    return 'complex'
  }
  if (/(^|\n) {0,3}(={2,}|-{2,}|\*{3,}|_{3,})\s*($|\n)/.test(block)) {
    return 'complex'
  }
  if (lines.length === 1 && HEADING.test(lines[0]!)) {
    return 'heading'
  }
  if (lines.some(l => HEADING.test(l))) {
    return 'complex'
  }
  if (LIST_ITEM.test(lines[0]!)) {
    // Top-level items only, each continuation line indented under its item; no nested list.
    for (const l of lines.slice(1)) {
      if (LIST_ITEM.test(l)) {
        continue
      }
      if (/^\s+([-*+]|\d{1,9}[.)])\s/.test(l)) {
        return 'complex'
      }
    }
    return 'list'
  }
  if (lines.some(l => LIST_ITEM.test(l))) {
    return 'complex'
  }
  return 'paragraph'
}

type Flags = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; underline?: boolean }

const PUNCT = /[!-/:-@[-`{-~]/
const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c)
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c)

/**
 * Inline Markdown over one item's content: which characters are visible and how each is styled.
 * A CommonMark subset: backslash escapes, code spans (a run of n backticks to the next run of n),
 * `**`/`__` strong, `~~` strikethrough, `*`/`_` emphasis (`_` not inside a word). An unmatched
 * delimiter stays literal text. Newlines are visible (a soft break is kept as a line break).
 */
export function inline(src: string): { visible: boolean[]; flags: Flags[] } {
  const n = src.length
  const visible = new Array<boolean>(n).fill(true)
  const flags: Flags[] = Array.from({ length: n }, () => ({}))
  const taken = new Array<boolean>(n).fill(false)
  // 1. code spans
  const runs = [...src.matchAll(/`+/g)]
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!
    if (open.index! > 0 && src[open.index! - 1] === '\\') {
      continue
    }
    const k = runs.findIndex((r, j) => j > i && r[0].length === open[0].length)
    if (k === -1) {
      continue
    }
    const close = runs[k]!
    const a = open.index!, b = close.index!
    for (let x = a; x < a + open[0].length; x++) { visible[x] = false; taken[x] = true }
    for (let x = b; x < b + close[0].length; x++) { visible[x] = false; taken[x] = true }
    for (let x = a + open[0].length; x < b; x++) { flags[x]!.code = true; taken[x] = true }
    i = k
  }
  // 2. escapes
  for (let i = 0; i < n - 1; i++) {
    if (taken[i] || src[i] !== '\\' || !PUNCT.test(src[i + 1]!)) {
      continue
    }
    visible[i] = false
    taken[i] = true
    taken[i + 1] = true
    i++
  }
  // 3. paired delimiters, longest first
  const pair = (d: string, flag: keyof Flags, intraword: boolean): void => {
    for (let i = 0; i <= n - d.length; i++) {
      if (!src.startsWith(d, i) || taken.slice(i, i + d.length).some(Boolean)) {
        continue
      }
      if (isSpace(src[i + d.length])) {
        continue
      } // an opener is followed by a non-space
      if (!intraword && isWord(src[i - 1])) {
        continue
      }
      let j = i + d.length + 1
      for (; j <= n - d.length; j++) {
        if (!src.startsWith(d, j) || taken.slice(j, j + d.length).some(Boolean)) {
          continue
        }
        if (isSpace(src[j - 1])) {
          continue
        } // a closer follows a non-space
        if (!intraword && isWord(src[j + d.length])) {
          continue
        }
        if (d.length === 1 && src[j + 1] === d) { j++; continue } // `*` must not close on half of `**`
        break
      }
      if (j > n - d.length) {
        continue
      }
      for (let x = i; x < i + d.length; x++) { visible[x] = false; taken[x] = true }
      for (let x = j; x < j + d.length; x++) { visible[x] = false; taken[x] = true }
      for (let x = i + d.length; x < j; x++) if (!flags[x]!.code) {
        flags[x]![flag] = true
      }
      i = j + d.length - 1
    }
  }
  pair('**', 'bold', true)
  pair('__', 'bold', false)
  pair('~~', 'strike', true)
  pair('*', 'italic', true)
  pair('_', 'italic', false)
  return { visible, flags }
}

function styleOfFlags(f: Flags, base: SpanStyle): SpanStyle {
  const s: SpanStyle = { ...base }
  if (f.bold) {
    s.bold = true
  }
  if (f.italic) {
    s.italic = true
  }
  if (f.strike) {
    s.strikethrough = true
  }
  if (f.underline) {
    s.underline = true
  }
  if (f.code) {
    s.color = 'permission'
  } // the engine's codespan colour
  return s
}

/** One drawn item: a prefix (`- `, `1. `) and the raw ranges of its content lines in the block. */
type Item = { prefix: string; indent: string; start: number; end: number; flags: Flags }

function items(block: string, kind: 'paragraph' | 'list' | 'heading'): Item[] {
  if (kind === 'paragraph') {
    return [{ prefix: '', indent: '', start: 0, end: block.length, flags: {} }]
  }
  if (kind === 'heading') {
    const h = HEADING.exec(block)!
    return [{ prefix: '', indent: '', start: h[0].length, end: block.replace(/[ \t]+#*[ \t]*$/, '').length, flags: h[1]!.length === 1 ? { bold: true, italic: true, underline: true } : { bold: true } }]
  }
  const out: Item[] = []
  let offset = 0
  for (const line of block.split('\n')) {
    const m = LIST_ITEM.exec(line)
    if (m) {
      const marker = /^\d/.test(m[1]!) ? `${parseInt(m[1]!, 10)}.` : '-'
      out.push({ prefix: marker + ' ', indent: ' '.repeat(marker.length + 1), start: offset + m[0].length, end: offset + line.length, flags: {} })
    } else if (out.length > 0) {
      out[out.length - 1]!.end = offset + line.length // a continuation line joins its item
    }
    offset += line.length + 1
  }
  return out
}

/**
 * Draws a block (paragraph, top-level list or single heading) as lines of spans, a mention's key styled
 * by `keyStyle` (merged over the inline style) and its decoration inserted at its anchor. Mentions are
 * relative to the block and in prose. Returns null for a block this module does not draw.
 */
export function drawBlock(block: string, mentions: readonly Mention[], decoration: (m: Mention) => readonly Span[], keyStyle: (m: Mention) => SpanStyle): Span[][] | null {
  const kind = classify(block)
  if (kind === 'fence' || kind === 'complex') {
    return null
  }
  const lines: Span[][] = []
  for (const it of items(block, kind)) {
    const content = block.slice(it.start, it.end)
    const { visible, flags } = inline(content)
    let line: Span[] = []
    pushSpan(line, it.prefix, {})
    const own = mentions.filter(m => m.start >= it.start && m.end <= it.end)
    const at = (rawIndex: number): Mention[] => own.filter(m => m.anchor === rawIndex)
    for (let k = 0; k <= content.length; k++) {
      for (const m of at(it.start + k)) for (const sp of decoration(m)) pushSpan(line, sp.s, sp.style)
      if (k === content.length) {
        break
      }
      const ch = content[k]!
      if (ch === '\n') {
        lines.push(line)
        line = []
        // a continuation line: the engine indents it under the item's text
        const rest = content.slice(k + 1)
        const lead = /^[ \t]*/.exec(rest)![0].length
        pushSpan(line, it.indent, {})
        k += lead
        continue
      }
      if (!visible[k]) {
        continue
      }
      const raw = it.start + k
      const key = own.find(m => raw >= m.start && raw < m.end)
      const base = styleOfFlags({ ...it.flags, ...flags[k]! }, {})
      pushSpan(line, ch, key ? { ...base, ...keyStyle(key) } : base)
    }
    lines.push(line)
  }
  return lines
}

/** A person's prompt is printable text, not Markdown: every line as typed, decorations inserted. */
export function drawPlain(text: string, mentions: readonly Mention[], decoration: (m: Mention) => readonly Span[], keyStyle: (m: Mention) => SpanStyle): Span[][] {
  const lines: Span[][] = []
  let line: Span[] = []
  for (let k = 0; k <= text.length; k++) {
    for (const m of mentions.filter(x => x.anchor === k)) for (const sp of decoration(m)) pushSpan(line, sp.s, sp.style)
    if (k === text.length) {
      break
    }
    const ch = text[k]!
    if (ch === '\n') { lines.push(line); line = []; continue }
    const key = mentions.find(m => k >= m.start && k < m.end)
    pushSpan(line, ch, key ? keyStyle(key) : {})
  }
  lines.push(line)
  return lines
}
