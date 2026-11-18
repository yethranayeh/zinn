// What a board column means, from what the CLI reports about it. Pure.
//
// Order of trust: the column's category (`column_category` on a task, `category` on a project's column), then
// the column's name, then where it sits on its board (`is_first`, `is_last`). A store before Zinn 0.45.0 has no
// categories, and the schema allows other values, so the fallbacks stay.
import type { ThemeColor } from './style'

/** Where a column sits on its board, as the CLI reports it (`is_first`, `is_last`). */
export type ColumnPos = { isFirst: boolean; isLast: boolean }

/** What the mod knows about one task's column. Null `category`: none the mod knows. Null `pos`: not reported. */
export type ColumnRef = { column: string; category: Category | null; pos: ColumnPos | null }

/** A mark: a single-cell geometric shape (no emoji: its width differs per terminal) and the theme key it is painted in. */
export type ColumnLook = { shape: string; color: ThemeColor }

/**
 * Per category. Colours are chosen against the engine's six theme tables (lib/themes.ts):
 * - `claude` is not used: in the ANSI themes it is redBright, the same as `error`. `warning` is yellow in every theme.
 * - `suggestion` equals `permission`, the colour of inline code, so a KEY is never `suggestion`. A glyph may be.
 * - `inactive` equals `subtle` in both ANSI themes: those marks differ by glyph only.
 */
export const CATEGORY_LOOK = {
  backlog: { shape: '○', color: 'inactive' },
  todo: { shape: '○', color: 'inactive' },
  in_progress: { shape: '◐', color: 'warning' },
  review: { shape: '◑', color: 'suggestion' },
  done: { shape: '●', color: 'success' },
  cancelled: { shape: '✕', color: 'inactive' },
} as const satisfies Record<string, ColumnLook>

/** The column categories the CLI reports. */
export type Category = keyof typeof CATEGORY_LOOK

/** The category in words, for a board header and a column name that does not say it. */
export const categoryWord = (c: Category): string => c.replace('_', ' ')

/** Marks by column name, for a store that gives no category. */
export const NAME_LOOK: Readonly<Record<string, ColumnLook>> = {
  'Backlog': CATEGORY_LOOK.backlog,
  'TODO': CATEGORY_LOOK.todo,
  'In Progress': CATEGORY_LOOK.in_progress,
  'Review': CATEGORY_LOOK.review,
  'Blocked': { shape: '⊘', color: 'error' },
  'Done': CATEGORY_LOOK.done,
}

const CATEGORIES: ReadonlySet<string> = new Set(Object.keys(CATEGORY_LOOK))
const CLOSED: ReadonlySet<Category> = new Set(['done', 'cancelled'])

/** A category the mod knows, else null. */
export const categoryOf = (v: unknown): Category | null => (typeof v === 'string' && CATEGORIES.has(v) ? (v as Category) : null)

/** The position the CLI reports in one JSON object, null when it reports none. */
export const posOf = (o: Record<string, unknown>): ColumnPos | null =>
  typeof o['is_first'] === 'boolean' || typeof o['is_last'] === 'boolean' ? { isFirst: o['is_first'] === true, isLast: o['is_last'] === true } : null

/**
 * The mark of a column: by category, then by name, then by position (first: not started, last: done, any other:
 * in flight). Null when none of them is known.
 */
export function lookOf(ref: ColumnRef): ColumnLook | null {
  if (ref.category !== null) {
    return CATEGORY_LOOK[ref.category]
  }
  const byName = NAME_LOOK[ref.column]
  if (byName !== undefined) {
    return byName
  }
  if (ref.pos === null) {
    return null
  }
  if (ref.pos.isFirst) {
    return CATEGORY_LOOK.backlog
  }
  return ref.pos.isLast ? CATEGORY_LOOK.done : CATEGORY_LOOK.in_progress
}

/** True for a column whose tasks are finished: `done` or `cancelled`, or the last column when there is no category. */
export const isClosed = (c: { category: Category | null } & ColumnPos): boolean => (c.category !== null ? CLOSED.has(c.category) : c.isLast)

/** True for a column of work not started yet: `backlog`, or the first column when there is no category. */
export const isBacklog = (c: { category: Category | null } & ColumnPos): boolean => (c.category !== null ? c.category === 'backlog' : c.isFirst)
