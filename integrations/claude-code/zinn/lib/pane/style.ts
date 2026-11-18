// The pane's spans and marks. Pure. Colours are Claude Code theme keys only, never hex or 256-colour values,
// and every meaning also carries as a character or bold/dim, so the pane reads with colour off.
import { lookOf, type Category, type ColumnPos } from '../columns'
import { ARCHIVED_SHAPE } from '../decorate'
import type { ThemeColor } from '../style'

export type SpanStyle = { color?: ThemeColor; dimColor?: boolean; bold?: boolean; italic?: boolean }
export type Span = { s: string; style: SpanStyle }

export const sp = (s: string, style: SpanStyle = {}): Span => ({ s, style })
export const dim = (s: string): Span => sp(s, { dimColor: true })
export const bold = (s: string): Span => sp(s, { bold: true })
export const spansText = (spans: readonly Span[]): string => spans.map(x => x.s).join('')

/** The mark of a column (lib/columns.ts). `?` when neither its category, its name nor its position is known. */
export function markOf(column: string, isArchived: boolean, c?: { category?: Category | null } & ColumnPos): Span {
  if (isArchived) {
    return sp(ARCHIVED_SHAPE, { color: 'subtle' })
  }
  const look = lookOf({ column, category: c?.category ?? null, pos: c === undefined ? null : { isFirst: c.isFirst, isLast: c.isLast } })
  return look === null ? sp('?') : sp(look.shape, { color: look.color })
}

/** Cuts to `max` characters, an ellipsis counting as one. `max` <= 0 returns ''. */
export function cut(s: string, max: number): string {
  if (max <= 0) {
    return ''
  }
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/** The priority as the CLI's list prints it: one capital letter, `-` for none. */
export const priorityLetter = (priority: string): string => (priority === '' ? '-' : priority[0]!.toUpperCase())

/** Epoch milliseconds as `YYYY-MM-DD` (UTC, as the CLI prints its times). '' for none. */
export function fmtDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return ''
  }
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}
