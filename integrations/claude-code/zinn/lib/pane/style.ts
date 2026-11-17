// The pane's spans and marks. Pure. Colours are Claude Code theme keys only, never hex or 256-colour values,
// and every meaning also carries as a character or bold/dim, so the pane reads with colour off.
import { ARCHIVED_SHAPE, SHAPES } from '../decorate'
import { COLUMN_COLOR, type ThemeColor } from '../style'

export type SpanStyle = { color?: ThemeColor; dimColor?: boolean; bold?: boolean; italic?: boolean }
export type Span = { s: string; style: SpanStyle }

export const sp = (s: string, style: SpanStyle = {}): Span => ({ s, style })
export const dim = (s: string): Span => sp(s, { dimColor: true })
export const bold = (s: string): Span => sp(s, { bold: true })
export const spansText = (spans: readonly Span[]): string => spans.map(x => x.s).join('')

/** Where a column sits on its board, as the CLI reports it (`is_first`, `is_last`). */
export type ColumnPos = { isFirst: boolean; isLast: boolean }

/**
 * The mark of a column. By name first (the transcript legend's table). A column with another name is judged by
 * where it sits: the first one is not started, the last one is done, any other is in flight.
 * `?` only when neither the name nor the position is known.
 */
export function markOf(column: string, isArchived: boolean, pos?: ColumnPos): Span {
  if (isArchived) {
    return sp(ARCHIVED_SHAPE, { color: 'subtle' })
  }
  const m = SHAPES[column]
  if (m !== undefined) {
    const c = COLUMN_COLOR[column]
    return sp(m, c === undefined ? {} : { color: c })
  }
  if (pos === undefined) {
    return sp('?')
  }
  if (pos.isFirst) {
    return sp('○', { color: 'inactive' })
  }
  if (pos.isLast) {
    return sp('●', { color: 'success' })
  }
  return sp('◐', { color: 'warning' })
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
