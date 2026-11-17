// What a decoration says (status first, then a title of at most about 40 characters. Priority and labels
// are left to the pane), and the text-rewrite looks. Pure.
import type { KeyInfo, Mention } from './keys'
import type { Config, Look, Marks } from './config'

/**
 * Status marks per board column. `shapes`: single-cell geometric shapes, no emoji (an emoji's width
 * differs per terminal). `words`: the column in lower case, readable without a legend and without colour.
 */
export const SHAPES: Readonly<Record<string, string>> = {
  'Backlog': '○',
  'TODO': '○',
  'In Progress': '◐',
  'Review': '◑',
  'Blocked': '⊘',
  'Done': '●',
}
export const ARCHIVED_SHAPE = '▪'
export const OTHER_SHAPE = '·'
export const UNKNOWN_MARK = '✗ not in Zinn'
export const SEPARATOR = ' · '

export function markFor(info: KeyInfo, marks: Marks): string {
  if (marks === 'words') {
    return info.isArchived ? 'archived' : (info.column || 'no column').toLowerCase()
  }
  if (info.isArchived) {
    return ARCHIVED_SHAPE
  }
  return SHAPES[info.column] ?? OTHER_SHAPE
}

/** At most `max` characters (code points), the last one an ellipsis when cut. Whitespace collapsed. 0 -> ''. */
export function cutTitle(title: string, max: number): string {
  if (max <= 0) {
    return ''
  }
  const flat = title.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  if (chars.length <= max) {
    return flat
  }
  if (max === 1) {
    return '…'
  }
  return chars.slice(0, max - 1).join('').trimEnd() + '…'
}

/** Backslash-escapes what Markdown would read in a title: emphasis, code, links, tables, html, headings. */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_[\]<>|#~])/g, '\\$1')
}

const norm = (s: string): string => s.toLowerCase().replace(/[*_`~\\]/g, '').replace(/\s+/g, ' ').trim()
const commonPrefix = (a: string, b: string): number => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/**
 * True when the text already carries the task's title right next to the key, so a decoration would
 * repeat it (`ABC-5: Add a pane…` would draw `ABC-5 · ◐ Add a pane… : Add a pane…`).
 *
 * After the key (past emphasis and a `:`, `-`, `—`, `(` or quote) the text must agree with the title's
 * start for at least 16 characters (or the whole title, if shorter). Before the key, on the same line,
 * the title's first 16 characters must appear within the title's length plus 20 characters.
 */
export function titleEchoed(text: string, m: Mention, title: string): boolean {
  const t = norm(title)
  if (t.length < 4) {
    return false
  }
  const need = Math.min(t.length, 16)
  let after = text.slice(m.anchor, m.anchor + t.length + 24)
  const nl = after.indexOf('\n')
  if (nl !== -1) {
    after = after.slice(0, nl)
  }
  after = after.replace(/^[\s:–—\-(*_"'“”‘’`]+/, '')
  if (commonPrefix(norm(after), t) >= need) {
    return true
  }
  let before = text.slice(Math.max(0, m.start - t.length - 20), m.start)
  const bl = before.lastIndexOf('\n')
  if (bl !== -1) {
    before = before.slice(bl + 1)
  }
  return norm(before).includes(t.slice(0, need))
}

/** What one mention's decoration carries, independent of the look. */
export type Deco =
  | { kind: 'known'; key: string; mark: string; title: string | null; column: string; isArchived: boolean }
  | { kind: 'unknown'; key: string }

/**
 * `keepEchoedTitle`: the legend under a reply sets it. Leaving out a title the text already carries fits a
 * decoration placed right after the key. A legend line stands apart from the text and is also the click target,
 * so it always carries the title.
 */
export function decoFor(text: string, m: Mention, cfg: Pick<Config, 'marks' | 'titleMax'>, keepEchoedTitle = false): Deco {
  if (m.kind === 'unknown' || m.info === null) {
    return { kind: 'unknown', key: m.key }
  }
  const cut = cutTitle(m.info.title, cfg.titleMax)
  const title = cut === '' || (!keepEchoedTitle && titleEchoed(text, m, m.info.title)) ? null : cut
  return { kind: 'known', key: m.key, mark: markFor(m.info, cfg.marks), title, column: m.info.column, isArchived: m.info.isArchived }
}

/** `◐ title` (shapes) or `in progress: title` (words). The mark alone when there is no title. */
export function markAndTitle(mark: string, title: string | null, marks: Marks): string {
  if (title === null) {
    return mark
  }
  return marks === 'words' ? `${mark}: ${title}` : `${mark} ${title}`
}

/**
 * The decoration as text, for the looks that rewrite the text (`suffix`, `brackets`).
 * `markdown`: the text is Markdown (a reply), so the title is escaped and the unknown mark is bold.
 * A person's prompt is drawn as printable text, not Markdown, so there nothing is escaped.
 */
export function decoText(d: Deco, look: 'suffix' | 'brackets', marks: Marks, markdown: boolean): string {
  const open = look === 'brackets' ? (markdown ? ' \\[' : ' [') : SEPARATOR
  const close = look === 'brackets' ? (markdown ? '\\]' : ']') : ''
  if (d.kind === 'unknown') {
    return open + (markdown ? `**${UNKNOWN_MARK}**` : UNKNOWN_MARK) + close
  }
  const body = markAndTitle(d.mark, d.title === null ? null : markdown ? escapeMarkdown(d.title) : d.title, marks)
  return open + body + close
}

/** The text with each mention's decoration inserted at its anchor (keys in code are never passed in). */
export function rewriteText(text: string, mentions: readonly Mention[], look: 'suffix' | 'brackets', cfg: Pick<Config, 'marks' | 'titleMax'>, markdown: boolean): string {
  let out = text
  for (const m of [...mentions].sort((a, b) => b.anchor - a.anchor)) {
    out = out.slice(0, m.anchor) + decoText(decoFor(text, m, cfg), look, cfg.marks, markdown) + out.slice(m.anchor)
  }
  return out
}

export const isRewriteLook = (l: Look): l is 'suffix' | 'brackets' => l === 'suffix' || l === 'brackets'
