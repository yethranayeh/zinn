// The pages beside the task layouts, as plain rows: one board, the list of boards, a task's whole
// description, a task's comments. Pure: hooks/pane.tsx turns rows into elements. They follow the `table`
// layout, which reads like the CLI's output: cells split by a dim bar, nothing wraps but prose, everything is
// cut to the width.
import { doneCount, openCount, type BoardColumn, type BoardTask, type BoardView, type ProjectRow } from './board'
import { commentWord, type Item, type Row } from './layouts'
import { bold, cut, dim, fmtDate, markOf, priorityLetter, sp, type Span } from './style'
import { DESCRIPTION_MAX, type TaskView } from './task'

export type Ctx = { width: number }

const BAR = ' │ '
/** A pressable row starts `n: ` when it has a digit. A row without one is indented by the same three cells. */
const LEAD_DIGIT = '  '
const LEAD_PLAIN = '     '
const rule = (w: number): Row => ({ kind: 'line', spans: [dim('─'.repeat(Math.min(Math.max(20, w), 60)))] })
const pressable = (item: Item): Row => ({ kind: 'rel', lead: [dim(item.n > 0 ? LEAD_DIGIT : LEAD_PLAIN)], item })

/** Rows a cut column shows before `a` is pressed. A column in flight is never cut: it is what the board is for. */
export const FIRST_ROWS = 10
export const LAST_ROWS = 5

/** The last column reads newest first (what was just finished). Every other column keeps its board order. */
function shown(col: BoardColumn, showAll: boolean): { tasks: BoardTask[]; hidden: number } {
  const all = col.isLast ? [...col.tasks].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) : col.tasks
  const cap = showAll ? all.length : col.isLast ? LAST_ROWS : col.isFirst ? FIRST_ROWS : all.length
  return { tasks: all.slice(0, cap), hidden: Math.max(0, all.length - cap) }
}

/**
 * One board: a header, then each column in board order with its tasks as pressable rows.
 * The nine digit keys go to the tasks in flight first (neither the first nor the last column), then to the
 * first column, then to the last: on a board with a long backlog the digits still reach the work under way.
 */
export function boardRows(b: BoardView, ctx: Ctx & { showAll: boolean }): Row[] {
  const w = Math.max(20, ctx.width)
  const rows: Row[] = []
  const head: Span[] = [bold(b.key), dim(BAR), sp(cut(b.name, 40)), dim(BAR), sp(`${openCount(b)} open`), dim(BAR), sp(`${doneCount(b)} done`)]
  if (b.archivedCount > 0) {
    head.push(dim(BAR), dim(`${b.archivedCount} archived`))
  }
  rows.push({ kind: 'line', spans: head })
  rows.push(rule(w))
  const cols = b.columns.map(col => ({ col, ...shown(col, ctx.showAll) }))
  // Digits, in the order of who needs them: in flight, then the first column, then the last.
  const digits = new Map<string, number>()
  const rank = (c: BoardColumn): number => (c.isLast ? 2 : c.isFirst ? 1 : 0)
  for (const c of [...cols].sort((x, y) => rank(x.col) - rank(y.col))) {
    for (const t of c.tasks) if (digits.size < 9) {
      digits.set(t.key, digits.size + 1)
    }
  }
  const kw = Math.max(0, ...cols.flatMap(c => c.tasks.map(t => t.key.length)))
  for (const { col, tasks, hidden } of cols) {
    const mark = markOf(col.name, false, col)
    const count = dim(` ${col.tasks.length}`)
    rows.push({ kind: 'line', spans: col.tasks.length === 0 ? [mark, sp(' '), dim(col.name || '(no column)'), count] : [mark, sp(' '), bold(col.name || '(no column)'), count] })
    for (const t of tasks) {
      // lead (5) + key + bar (3) + priority (1) + bar (3)
      const room = w - (5 + kw + 3 + 1 + 3)
      const tail = [t.dueAt !== null ? `due ${fmtDate(t.dueAt)}` : '', t.labels.join(', ')].filter(Boolean).join(' · ')
      const fits = tail !== '' && t.title.length + 3 + tail.length <= room
      const spans: Span[] = [sp(t.key.padEnd(kw), { bold: true }), dim(BAR), sp(priorityLetter(t.priority)), dim(BAR), sp(cut(t.title, room))]
      if (fits) {
        spans.push(dim(BAR), dim(tail))
      }
      rows.push(pressable({ n: digits.get(t.key) ?? 0, target: { kind: 'task', key: t.key }, spans }))
    }
    if (hidden > 0) {
      rows.push({ kind: 'line', spans: [dim(`${LEAD_PLAIN}… ${hidden} more`)] })
    }
  }
  if (b.columns.length === 0) {
    rows.push({ kind: 'line', spans: [dim('no columns')] })
  }
  return rows
}

/** True when some column of the board is cut, so the `all` switch has something to do. */
export const boardIsCut = (b: BoardView): boolean => b.columns.some(c => shown(c, false).hidden > 0)

/** The list of boards: each one a pressable row that opens its board. */
export function projectRows(projects: readonly ProjectRow[], ctx: Ctx): Row[] {
  const w = Math.max(20, ctx.width)
  const rows: Row[] = []
  rows.push({ kind: 'line', spans: [bold('Boards'), dim(` ${projects.length}`)] })
  rows.push(rule(w))
  if (projects.length === 0) {
    rows.push({ kind: 'line', spans: [dim('no boards in this store')] })
  }
  const kw = Math.max(0, ...projects.map(p => p.key.length))
  const aw = Math.max(0, ...projects.map(p => String(p.active).length))
  const nw = Math.max(8, Math.min(Math.max(0, ...projects.map(p => p.name.length)), w - (5 + kw + 3 + 3 + aw + 7)))
  projects.forEach((p, i) => {
    const spans: Span[] = [sp(p.key.padEnd(kw), { bold: true }), dim(BAR), sp(cut(p.name, nw).padEnd(nw)), dim(BAR), sp(`${String(p.active).padStart(aw)} active`)]
    if (p.archived > 0) {
      spans.push(dim(BAR), dim(`${p.archived} archived`))
    }
    rows.push(pressable({ n: i < 9 ? i + 1 : 0, target: { kind: 'board', key: p.key }, spans }))
  })
  return rows
}

const taskHead = (t: TaskView, w: number, what: string): Row => ({ kind: 'line', spans: [markOf(t.column, t.status === 'Archived', t), sp(' '), bold(t.key), dim(BAR), sp(cut(t.title, Math.max(8, w - t.key.length - what.length - 8))), dim(BAR), dim(what)] })

/** The whole description, as the Markdown it is written in (the `meta.*` footer included: it is the assignment). */
export function descriptionRows(t: TaskView, ctx: Ctx): Row[] {
  const w = Math.max(20, ctx.width)
  const rows: Row[] = [taskHead(t, w, 'description'), rule(w)]
  if (t.description.trim() === '') {
    rows.push({ kind: 'line', spans: [dim('no description')] })
  } else {
    rows.push({ kind: 'md', text: t.description })
  }
  if (t.description.length >= DESCRIPTION_MAX) {
    rows.push({ kind: 'line', spans: [dim(`cut at ${DESCRIPTION_MAX} characters: zinn task view ${t.key}`)] })
  }
  return rows
}

/** The comments, newest first: a dim line with the comment's key and day, then its text as Markdown. */
export function commentRows(t: TaskView, ctx: Ctx): Row[] {
  const w = Math.max(20, ctx.width)
  const rows: Row[] = [taskHead(t, w, commentWord(t.commentCount)), rule(w)]
  if (t.comments.length === 0) {
    rows.push({ kind: 'line', spans: [dim('no comments')] })
  }
  t.comments.forEach((c, i) => {
    if (i > 0) {
      rows.push({ kind: 'blank' })
    }
    const day = fmtDate(c.createdAt)
    rows.push({ kind: 'line', spans: [bold(c.key || '#'), ...(day ? [dim(BAR), dim(day)] : [])] })
    rows.push({ kind: 'md', text: c.text })
  })
  if (t.commentCount > t.comments.length) {
    rows.push({ kind: 'blank' }, { kind: 'line', spans: [dim(`${t.commentCount - t.comments.length} older: zinn task view ${t.key}`)] })
  }
  return rows
}
