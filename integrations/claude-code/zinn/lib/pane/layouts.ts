// The three layouts of a task's overview, as plain rows. Pure: hooks/pane.tsx turns rows into elements. Every layout shows the same fields (title, status, column, priority, labels,
// relations, the first paragraph of the description, the comment count) and differs in how it spends
// the room.
import type { Relation, TaskView } from './task'
import { firstParagraph } from './task'
import { bold, cut, dim, fmtDate, markOf, sp, type Span } from './style'
import type { Layout } from './resolve'
import { claimLine, type ClaimCtx } from '../claims'

/** What a press on an item opens: a task, or a project's board. */
export type ItemTarget = { kind: 'task' | 'board'; key: string }
/** A pressable row. `n` 1..9 is its digit key. 0 has none (pressed by a click, or Tab and Enter). */
export type Item = { n: number; target: ItemTarget; spans: Span[] }
export type Row =
  | { kind: 'line'; spans: Span[]; wrap?: boolean }
  | { kind: 'blank' }
  | { kind: 'rels'; items: Item[] }
  | { kind: 'rel'; item: Item; lead: Span[] }
  /** A block of Markdown (a description, a comment), drawn by the engine's own Markdown element. */
  | { kind: 'md'; text: string }

/** `claims`: who holds the task is drawn only with it (this session's id and the time). */
export type Ctx = { width: number; claims?: ClaimCtx }

/** The claim line, when the task has a claim. `lead` goes before it. */
function claimRows(t: TaskView, ctx: Ctx, lead: Span[] = []): Row[] {
  const spans = ctx.claims === undefined ? null : claimLine(t.claim, ctx.claims.me, ctx.claims.now)
  return spans === null ? [] : [{ kind: 'line', spans: [...lead, ...spans] }]
}


export const DESC_MAX: Record<Layout, number> = { card: 160, sectioned: 600, table: 240 }

/** The digit key of the i-th pressable row: 1..9, then none. */
export const digit = (i: number): number => (i < 9 ? i + 1 : 0)

export const commentWord = (n: number): string => (n === 0 ? 'no comments' : n === 1 ? '1 comment' : `${n} comments`)
const taskMark = (t: TaskView): Span => markOf(t.column, t.status === 'Archived', t)
const statusLine = (t: TaskView): Span[] => [taskMark(t), sp(' '), sp(t.column || '(no column)'), ...(t.status === 'Archived' ? [dim(' (archived)')] : [])]

function relSpans(r: Relation): Span[] {
  return [sp(r.key, { bold: true }), sp(' '), markOf(r.column, r.isArchived, r)]
}

function ordered(t: TaskView): Relation[] {
  const rank = (r: Relation): number => (r.verb === 'depends on' ? 0 : r.verb === 'blocks' ? 1 : r.verb === 'subtask of' ? 2 : r.verb === 'subtasks' ? 3 : 4)
  return [...t.relations].sort((a, b) => rank(a) - rank(b))
}

export function layoutRows(layout: Layout, t: TaskView, ctx: Ctx): Row[] {
  return layout === 'card' ? card(t, ctx) : layout === 'sectioned' ? sectioned(t, ctx) : table(t, ctx)
}

/** A. compact card: five or six rows, relations as one wrapped line of keys. */
function card(t: TaskView, ctx: Ctx): Row[] {
  const rows: Row[] = []
  const meta: Span[] = [taskMark(t), sp(' '), bold(t.key), dim('  '), sp(t.column || '(no column)')]
  if (t.priority) {
    meta.push(dim(' · '), sp(t.priority))
  }
  if (t.labels.length > 0) {
    meta.push(dim(' · '), sp(t.labels.join(', ')))
  }
  if (t.dueAt !== null) {
    meta.push(dim(' · '), sp(`due ${fmtDate(t.dueAt)}`))
  }
  if (t.status === 'Archived') {
    meta.push(dim(' · archived'))
  }
  rows.push({ kind: 'line', spans: meta })
  rows.push(...claimRows(t, ctx))
  rows.push({ kind: 'line', spans: [bold(t.title)], wrap: true })
  const rels = ordered(t)
  if (rels.length > 0) {
    // One wrapped row of items, each led by its verb: "depends on ABC-6 ◐".
    rows.push({ kind: 'rels', items: rels.map((r, i) => ({ n: digit(i), target: { kind: 'task', key: r.key }, spans: [dim(r.verb + ' '), ...relSpans(r)] })) })
  }
  const d = firstParagraph(t.description, DESC_MAX.card).text
  if (d !== '') {
    rows.push({ kind: 'line', spans: [dim(d)], wrap: true })
  }
  rows.push({ kind: 'line', spans: [dim(commentWord(t.commentCount))] })
  return rows
}

/** B. sectioned detail: labelled fields, relations grouped by meaning with titles, a longer description. */
function sectioned(t: TaskView, ctx: Ctx): Row[] {
  const rows: Row[] = []
  rows.push({ kind: 'line', spans: [bold(t.key), dim('  '), ...statusLine(t)] })
  rows.push({ kind: 'line', spans: [bold(t.title)], wrap: true })
  rows.push({ kind: 'blank' })
  const field = (k: string, v: string): Row => ({ kind: 'line', spans: [dim(k.padEnd(10)), sp(v)] })
  rows.push(field('Status', t.status || '—'))
  rows.push(field('Column', t.column || '—'))
  rows.push(field('Priority', t.priority || '—'))
  rows.push(field('Labels', t.labels.length > 0 ? t.labels.join(', ') : '—'))
  rows.push(field('Due', fmtDate(t.dueAt) || '—'))
  rows.push(field('Updated', fmtDate(t.updatedAt) || '—'))
  rows.push(field('Comments', String(t.commentCount)))
  rows.push(...claimRows(t, ctx, [dim('Claim'.padEnd(10))]))
  const rels = ordered(t)
  rows.push({ kind: 'blank' })
  rows.push({ kind: 'line', spans: [dim('Relations')] })
  if (rels.length === 0) {
    rows.push({ kind: 'line', spans: [dim('  none')] })
  }
  rels.forEach((r, i) => {
    rows.push({ kind: 'rel', lead: [dim('  ' + r.verb.padEnd(13))], item: { n: digit(i), target: { kind: 'task', key: r.key }, spans: [...relSpans(r), dim('  '), sp(r.title)] } })
  })
  const d = firstParagraph(t.description, DESC_MAX.sectioned)
  rows.push({ kind: 'blank' })
  rows.push({ kind: 'line', spans: [dim('Description')] })
  rows.push({ kind: 'line', spans: [sp(d.text === '' ? '—' : d.text)], wrap: true })
  return rows
}

/** C. dense table: one header row, then columns aligned; nothing wraps, everything is cut to the width. */
function table(t: TaskView, ctx: Ctx): Row[] {
  const w = Math.max(20, ctx.width)
  const rows: Row[] = []
  const head: Span[] = [taskMark(t), sp(' '), bold(t.key), dim(' │ '), sp(t.column || '—'), dim(' │ '), sp(t.priority || '—'), dim(' │ '), sp(t.labels.length > 0 ? t.labels.join(',') : '—'), dim(' │ '), sp(commentWord(t.commentCount).replace('no comments', '0 comments'))]
  // A due date takes a cell only when the task has one: the header of an undated task is as it was.
  if (t.dueAt !== null) {
    head.push(dim(' │ '), sp(`due ${fmtDate(t.dueAt)}`))
  }
  rows.push({ kind: 'line', spans: head })
  rows.push(...claimRows(t, ctx))
  rows.push({ kind: 'line', spans: [bold(cut(t.title, w))] })
  rows.push({ kind: 'line', spans: [dim('─'.repeat(Math.min(w, 60)))] })
  const rels = ordered(t)
  const vw = Math.max(0, ...rels.map(r => r.verb.length))
  const kw = Math.max(0, ...rels.map(r => r.key.length))
  rels.forEach((r, i) => {
    const lead = [dim(r.verb.padEnd(vw) + ' │ ')]
    const used = vw + kw + 13 // lead + "n: " + key + " │ " + mark + " │ "
    rows.push({ kind: 'rel', lead, item: { n: digit(i), target: { kind: 'task', key: r.key }, spans: [sp(r.key.padEnd(kw), { bold: true }), dim(' │ '), markOf(r.column, r.isArchived, r), dim(' │ '), sp(cut(r.title, w - used))] } })
  })
  if (rels.length > 0) {
    rows.push({ kind: 'line', spans: [dim('─'.repeat(Math.min(w, 60)))] })
  }
  const d = firstParagraph(t.description, Math.min(DESC_MAX.table, w * 2 - 2))
  rows.push({ kind: 'line', spans: [dim(d.text === '' ? '—' : d.text)], wrap: true })
  return rows
}

export const rowText = (r: Row): string =>
  r.kind === 'blank' ? '' : r.kind === 'md' ? r.text : r.kind === 'line' ? r.spans.map(s => s.s).join('') : r.kind === 'rels' ? r.items.map(i => i.spans.map(s => s.s).join('')).join('  ') : r.lead.map(s => s.s).join('') + r.item.spans.map(s => s.s).join('')
