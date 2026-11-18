// The pane's pure parts, run host-free through the same runner.
import { test, expect } from 'claude-code/testing'
import { BARE, BOARD_TASKS, CATEGORY_PROJECT, CATEGORY_TASKS, DUE, LONG, NOT_FOUND, PROJECT, PROJECTS, T0, TASK } from './pane-fixtures'
import { COMMENTS_KEPT, COMMENT_MAX, failureOf, failureReason, firstParagraph, parseTask, projectOf } from '../lib/pane/task'
import { candidateKeys, MAX_TRIES, parseArgs, resolveTarget } from '../lib/pane/resolve'
import { layoutRows, rowText, type Row } from '../lib/pane/layouts'
import { LAYOUTS } from '../lib/pane/resolve'
import { parseConfig } from '../lib/pane/config'
import { back, EMPTY, entryName, loadingBoard, loadingProjects, loadingTask, onTop, push, settle } from '../lib/pane/model'
import { closedCount, openCount, parseBoard, parseProjects } from '../lib/pane/board'
import { boardIsCut, boardRows, commentRows, descriptionRows, BACKLOG_ROWS, CLOSED_ROWS, projectRows } from '../lib/pane/views'
import { fmtDate, markOf, priorityLetter } from '../lib/pane/style'

const board = () => parseBoard(JSON.stringify(PROJECT), JSON.stringify(BOARD_TASKS))
const digits = (rows: readonly Row[]): Record<string, number> => Object.fromEntries(rows.flatMap(r => (r.kind === 'rel' && r.item.n > 0 ? [[r.item.target.key, r.item.n]] : [])))

test('parseTask: fields, relation verbs, comment count', async () => {
  const t = parseTask(JSON.stringify(TASK))
  expect(t.key).toBe('ZCC-8')
  expect(t.commentCount).toBe(2)
  expect(t.labels).toEqual(['frontend', 'pane'])
  expect(t.relations.map(r => `${r.verb} ${r.key}`)).toEqual(['depends on ZCC-6', 'blocks ZCC-9', 'subtasks ZCC-16'])
  expect(parseTask(JSON.stringify(BARE)).relations).toEqual([])
})

test('parseTask: comments newest first, cut and capped; due and updated as numbers; a related relation has no direction', async () => {
  const t = parseTask(JSON.stringify(TASK))
  expect(t.comments.map(c => c.key)).toEqual(['ZCC-8#2', 'ZCC-8#1'])
  expect(t.comments[1]?.createdAt).toBe(T0)
  expect(t.dueAt).toBeNull()
  expect(fmtDate(t.updatedAt)).toBe('2026-10-14')
  expect(parseTask(JSON.stringify(DUE)).dueAt).toBe(Date.UTC(2026, 10, 20))
  const many = parseTask(JSON.stringify({ ...TASK, comments: Array.from({ length: COMMENTS_KEPT + 5 }, (_, i) => ({ key: `ZCC-8#${i + 1}`, text: 'x'.repeat(COMMENT_MAX + 50), created_at: T0 + i })) }))
  expect(many.commentCount).toBe(COMMENTS_KEPT + 5) // the count is of all of them
  expect(many.comments).toHaveLength(COMMENTS_KEPT)
  expect(many.comments[0]?.key).toBe(`ZCC-8#${COMMENTS_KEPT + 5}`)
  expect(many.comments[0]?.text.length).toBe(COMMENT_MAX)
  // As 0.44.0 prints a `related` relation: direction null.
  const rel = parseTask(JSON.stringify({ ...TASK, relations: [{ type: 'related', direction: null, task: { key: 'ZCC-10', column: 'Backlog', is_first: true, is_last: false, title: 't', status: 'Active' } }] }))
  expect(rel.relations.map(r => `${r.verb} ${r.key} ${r.isFirst}`)).toEqual(['related ZCC-10 true'])
  expect(projectOf('ZCC-8')).toBe('ZCC')
})

test('parseTask: not a task is a thrown reason, not a crash elsewhere', async () => {
  expect(() => parseTask('[]')).toThrow()
  expect(() => parseTask('{}')).toThrow()
  expect(() => parseTask('nope')).toThrow()
})

test('failureReason: the stderr envelope', async () => {
  expect(failureReason({ exitCode: 1, stderr: '{"error":{"message":"Task ZCC-99 not found"}}' })).toBe('exit 1: Task ZCC-99 not found')
  expect(failureReason({ exitCode: 2, stderr: 'boom\nmore' })).toBe('exit 2: boom')
})

test('failureOf: the code is read from the envelope (pretty-printed, as the CLI writes it), never from the message', async () => {
  expect(failureOf({ exitCode: 1, stderr: NOT_FOUND('Task ZCC-99') })).toEqual({ code: 'not_found', reason: 'exit 1: Task ZCC-99 not found' })
  expect(failureOf({ exitCode: 1, stderr: '{"error":{"code":"storage","message":"x not found"}}' }).code).toBe('storage')
  expect(failureOf({ exitCode: 1, stderr: 'not found' }).code).toBeNull()
  expect(failureOf({ exitCode: 0, stderr: '', isStdoutTruncated: true })).toEqual({ code: null, reason: 'output over 4 MiB' })
})

test('firstParagraph: stops at the blank line and at the meta footer; a long one is cut with one ellipsis', async () => {
  expect(firstParagraph(TASK.description, 200).text).toBe("OpenCode modal, done the Claude Code way.")
  expect(firstParagraph('meta.agent: x', 50).text).toBe('')
  expect(firstParagraph('', 50).text).toBe('')
  const c = firstParagraph(LONG, 100)
  expect(c.isCut).toBe(true)
  expect(c.text.length).toBe(100)
  expect(c.text.endsWith('…')).toBe(true)
})

test('candidateKeys: slugs, versions and file names are not keys', async () => {
  expect(candidateKeys('see ZCC-8, ZCC-6 and ZCC-8 again; SHA-256 UTF-8 2026-10-09-ZCC-5-x ZCC-7.md')).toEqual(['ZCC-8', 'ZCC-6', 'SHA-256', 'UTF-8'])
})

test('parseArgs: key, project and layout in any order; lower case accepted; a layout name wins; junk reported', async () => {
  expect(parseArgs('zcc-8 table')).toEqual({ key: 'ZCC-8', project: null, layout: 'table', bad: null })
  expect(parseArgs('card')).toEqual({ key: null, project: null, layout: 'card', bad: null })
  expect(parseArgs('')).toEqual({ key: null, project: null, layout: null, bad: null })
  expect(parseArgs('zcc')).toEqual({ key: null, project: 'ZCC', layout: null, bad: null })
  expect(parseArgs('sectioned DSGN')).toEqual({ key: null, project: 'DSGN', layout: 'sectioned', bad: null })
  expect(parseArgs('Table').project).toBeNull() // the layout, not a board keyed TABLE
  expect(parseArgs('zcc_8').bad).toBe('zcc_8')
  expect(parseArgs('--all ZCC-8').bad).toBe('--all')
})

test('resolveTarget: argument, then selection, then the list of boards; the store is not asked here', async () => {
  const none = parseArgs('')
  expect(resolveTarget({ args: parseArgs('ZCC-8'), selection: 'ZCC-6' })).toEqual({ kind: 'task', keys: ['ZCC-8'], from: 'argument' })
  expect(resolveTarget({ args: parseArgs('zcc'), selection: 'ZCC-6' })).toEqual({ kind: 'board', project: 'ZCC', from: 'argument' })
  expect(resolveTarget({ args: parseArgs('ZCC ZCC-8'), selection: undefined })).toEqual({ kind: 'task', keys: ['ZCC-8'], from: 'argument' }) // a task key before a project key
  expect(resolveTarget({ args: none, selection: 'blocked by SHA-256 then ZCC-6' })).toEqual({ kind: 'task', keys: ['SHA-256', 'ZCC-6'], from: 'selection' })
  expect(resolveTarget({ args: none, selection: ' ZCC ' })).toEqual({ kind: 'board', project: 'ZCC', from: 'selection' })
  expect(resolveTarget({ args: none, selection: 'the' })).toEqual({ kind: 'none', message: 'zinn-show: no Zinn task key in the selection' }) // never upper-cased
  expect(resolveTarget({ args: none, selection: 'plain words' }).kind).toBe('none')
  expect(resolveTarget({ args: none, selection: undefined })).toEqual({ kind: 'projects' })
  expect(resolveTarget({ args: none, selection: '  ' })).toEqual({ kind: 'projects' })
  const many = resolveTarget({ args: none, selection: 'A-1 A-2 A-3 A-4 A-5 A-6' })
  expect(many.kind === 'task' && many.keys.length).toBe(MAX_TRIES)
  const bad = resolveTarget({ args: parseArgs('zz_z'), selection: undefined })
  expect(bad.kind === 'none' && bad.message.split('\n').length).toBe(1)
})

test('every layout shows every field', async () => {
  const t = parseTask(JSON.stringify(TASK))
  for (const l of LAYOUTS) {
    for (const width of [40, 80, 160]) {
      const text = layoutRows(l, t, { width }).map(rowText).join('\n')
      for (const must of ['ZCC-8', 'Task detail pane', 'In Progress', 'medium', 'frontend', 'ZCC-6', 'ZCC-9', 'ZCC-16', "OpenCode modal"]) expect(text).toContain(must)
      expect(/2 comments|Comments {2}2/.test(text)).toBe(true)
      expect(text).not.toContain('meta.agent')
      expect(text).not.toContain('due ') // an undated task: the header is as it was
    }
  }
})

test('a due date shows in every layout; without a category, a column the name table does not name is marked by where it sits', async () => {
  const t = parseTask(JSON.stringify(DUE))
  for (const l of LAYOUTS) expect(layoutRows(l, t, { width: 100 }).map(rowText).join('\n')).toContain('2026-11-20')
  expect(markOf('Doing', false, { isFirst: false, isLast: false }).s).toBe('◐')
  expect(markOf('Inbox', false, { isFirst: true, isLast: false }).s).toBe('○')
  expect(markOf('Shipped', false, { isFirst: false, isLast: true }).s).toBe('●')
  expect(markOf('Doing', false).s).toBe('?')
  expect(markOf('Done', false, { isFirst: true, isLast: false }).s).toBe('●') // a known name wins over the position
  expect(markOf('Doing', true, { isFirst: false, isLast: false }).s).toBe('▪')
  expect(layoutRows('table', t, { width: 100 }).map(rowText).join('\n')).not.toContain('?')
  expect([priorityLetter('high'), priorityLetter('urgent'), priorityLetter('')]).toEqual(['H', 'U', '-'])
  expect([fmtDate(null), fmtDate(Number.NaN), fmtDate(0)]).toEqual(['', '', '1970-01-01'])
})

test('layouts: an empty task still draws; no relations, no description, no labels; the table never exceeds its width', async () => {
  const t = parseTask(JSON.stringify(BARE))
  for (const l of LAYOUTS) {
    const rows = layoutRows(l, t, { width: 30 })
    expect(rows.length > 0).toBe(true)
    expect(rows.map(rowText).join('\n')).toContain('ZCC-1')
  }
  const wide = parseTask(JSON.stringify({ ...TASK, relations: [{ type: 'related', direction: 'outgoing', task: { key: 'ZCC-6', column: 'Done', title: LONG, status: 'Active' } }] }))
  for (const r of layoutRows('table', wide, { width: 60 })) if (r.kind === 'rel') {
    expect((rowText(r) + '  ').length <= 64).toBe(true)
  }
})

test('long description is cut in each layout, to its own budget', async () => {
  const t = parseTask(JSON.stringify({ ...TASK, description: LONG }))
  const longest = (l: (typeof LAYOUTS)[number]): number => Math.max(...layoutRows(l, t, { width: 100 }).map(r => rowText(r).length))
  expect(longest('card')).toBeLessThanOrEqual(200)
  expect(longest('sectioned')).toBeLessThanOrEqual(600)
  expect(longest('table')).toBeLessThanOrEqual(240)
})

test('parseConfig: option beats variable beats default', async () => {
  expect(parseConfig({}, {}).layout).toBe('table')
  expect(parseConfig({ layout: 'from-env' }, { layout: 'Table' })).toMatchObject({ layout: 'table', layoutSource: 'env' })
  expect(parseConfig({ layout: 'card' }, { layout: 'table' })).toMatchObject({ layout: 'card', layoutSource: 'option' })
  expect(parseConfig({ layout: 'from-env' }, { layout: 'bogus' }).layout).toBe('table')
  expect(parseConfig({ pane: false }, {}).enabled).toBe(false)
})

test('history: push, replace the same top, settle, back; the last one has nothing under it', async () => {
  let v = push(EMPTY, loadingTask('A-1'))
  v = push(v, loadingTask('A-2'))
  v = push(v, loadingTask('A-2'))
  expect(v.stack.map(x => x.key)).toEqual(['A-1', 'A-2'])
  v = settle(v, { ...loadingTask('A-1'), state: 'failed', error: 'x' })
  expect(v.stack[0]?.state).toBe('failed')
  const b = back(v)
  expect(b?.stack.map(x => x.key)).toEqual(['A-1'])
  expect(back(b!)).toBeNull()
})

test('history across kinds: a board and a task of one key are two entries; a settle keeps the tab and show-all', async () => {
  let v = push(EMPTY, loadingProjects())
  v = push(v, loadingBoard('ZCC'))
  v = push(v, loadingTask('ZCC-8'))
  expect(v.stack.map(entryName)).toEqual(['boards', 'ZCC board', 'ZCC-8'])
  v = onTop(v, t => (t.kind === 'task' ? { ...t, tab: 'comments' } : t))
  v = settle(v, { ...loadingTask('ZCC-8'), state: 'ready', task: parseTask(JSON.stringify(TASK)) }) // a re-read
  const top = v.stack[2]
  expect(top?.kind === 'task' && top.tab).toBe('comments')
  v = back(v)!
  v = onTop(v, t => (t.kind === 'board' ? { ...t, showAll: true } : t))
  v = settle(v, { ...loadingBoard('ZCC'), state: 'ready', board: board() })
  const b = v.stack[1]
  expect(b?.kind === 'board' && b.showAll && b.state).toBe('ready')
  expect(onTop(EMPTY, t => t)).toEqual(EMPTY)
})

test('parseBoard: the columns in the project\'s order, an empty one kept; archived rows and junk dropped; counts', async () => {
  const b = board()
  expect(b.columns.map(c => `${c.name}:${c.tasks.length}`)).toEqual(['Backlog:12', 'TODO:0', 'In Progress:2', 'Done:7'])
  expect([b.key, b.name, b.archivedCount, openCount(b), closedCount(b)]).toEqual(['ZCC', 'Claude Code mods', 1, 14, 7])
  const odd = parseBoard(JSON.stringify(PROJECT), JSON.stringify([{ key: 'ZCC-1', status: 'Archived', column: 'Done' }, null, { key: 'ZCC-2', status: 'Active', column: 'Elsewhere', is_last: true }]))
  expect(odd.columns.map(c => `${c.name}:${c.tasks.length}`)).toEqual(['Backlog:0', 'TODO:0', 'In Progress:0', 'Done:0', 'Elsewhere:1']) // nothing listed is dropped
  expect(() => parseBoard('[]', '[]')).toThrow()
  expect(() => parseBoard(JSON.stringify(PROJECT), '{}')).toThrow()
  expect(parseProjects(JSON.stringify(PROJECTS)).map(p => `${p.key}:${p.active}:${p.archived}`)).toEqual(['SAM:31:20', 'ZCC:20:1', 'TS:51:0'])
  expect(() => parseProjects('{}')).toThrow()
})

test('boardRows: a cut first and last column, in flight never cut; done newest first; digits go to the work in flight first', async () => {
  const b = board()
  const rows = boardRows(b, { width: 100, showAll: false })
  const text = rows.map(rowText).join('\n')
  expect(text).toContain('ZCC │ Claude Code mods │ 14 open │ 7 closed │ 1 archived')
  expect(rows.filter(r => r.kind === 'rel')).toHaveLength(BACKLOG_ROWS + 2 + CLOSED_ROWS)
  expect(text).toContain('… 2 more')
  expect(boardIsCut(b)).toBe(true)
  // In flight first (ZCC-8, ZCC-6), then the backlog in board order.
  const d = digits(rows)
  expect([d['ZCC-8'], d['ZCC-6'], d['ZCC-100'], d['ZCC-106']]).toEqual([1, 2, 3, 9])
  expect(d['ZCC-107']).toBeUndefined()
  // Done reads newest first: ZCC-206 was updated last.
  const done = rows.flatMap(r => (r.kind === 'rel' && r.item.target.key.startsWith('ZCC-2') ? [r.item.target.key] : []))
  expect(done).toEqual(['ZCC-206', 'ZCC-205', 'ZCC-204', 'ZCC-203', 'ZCC-202'])
  // A row: key, priority letter, title, and the due day and labels when they fit.
  expect(text).toContain('ZCC-8   │ H │ Task detail pane │ frontend, pane')
  expect(text).toContain('ZCC-6   │ - │ Build key-lines MVP │ due 2026-11-20')
  const all = boardRows(b, { width: 100, showAll: true })
  expect(all.filter(r => r.kind === 'rel')).toHaveLength(BOARD_TASKS.length)
  expect(all.map(rowText).join('\n')).not.toContain('more')
  // Nothing wraps: no row is wider than the pane, at any width.
  for (const width of [30, 60, 100]) for (const r of boardRows(b, { width, showAll: true })) expect(rowText(r).length <= Math.max(60, width)).toBe(true)
  expect(boardRows({ key: 'X', name: 'Empty', columns: [], archivedCount: 0 }, { width: 80, showAll: false }).map(rowText).join('\n')).toContain('no columns')
  expect(boardIsCut({ key: 'X', name: 'Empty', columns: [], archivedCount: 0 })).toBe(false)
})

test('projectRows: one pressable row per board, aligned; description and comment pages', async () => {
  const rows = projectRows(parseProjects(JSON.stringify(PROJECTS)), { width: 80 })
  expect(rows.flatMap(r => (r.kind === 'rel' ? [`${r.item.n}:${r.item.target.kind}:${r.item.target.key}`] : []))).toEqual(['1:board:SAM', '2:board:ZCC', '3:board:TS'])
  const text = rows.map(rowText).join('\n')
  expect(text).toContain('SAM │ Sandboxes        │ 31 active │ 20 archived')
  expect(text).toContain('TS  │ Text search tool │ 51 active')
  expect(projectRows([], { width: 80 }).map(rowText).join('\n')).toContain('no boards')
  const t = parseTask(JSON.stringify(TASK))
  const desc = descriptionRows(t, { width: 80 })
  expect(desc.filter(r => r.kind === 'md').map(rowText)).toEqual([TASK.description]) // whole, the meta footer included
  expect(descriptionRows(parseTask(JSON.stringify(BARE)), { width: 80 }).map(rowText).join('\n')).toContain('no description')
  const com = commentRows(t, { width: 80 }).map(rowText)
  expect(com.join('\n')).toContain('2 comments')
  expect(com.indexOf('ZCC-8#2 │ 2026-10-13') < com.indexOf('ZCC-8#1 │ 2026-10-12')).toBe(true) // newest first
  expect(com).toContain('Agent picked `table`.')
  expect(commentRows(parseTask(JSON.stringify(BARE)), { width: 80 }).map(rowText).join('\n')).toContain('no comments')
})

test('ZCC-5 board by category: closed columns counted, cut and sorted wherever they sit; the category word where the name does not say it', async () => {
  const b = parseBoard(JSON.stringify(CATEGORY_PROJECT), JSON.stringify(CATEGORY_TASKS))
  expect([openCount(b), closedCount(b)]).toEqual([3, 8])
  const rows = boardRows(b, { width: 100, showAll: false })
  const lines = rows.map(rowText)
  const head = (name: string) => lines.find(l => l.includes(name) && !l.includes('│'))!
  expect([head('Backlog'), head('Blocked'), head('Doing'), head('Erledigt'), head('Cancelled')].map(l => l[0])).toEqual(['○', '○', '◐', '●', '⊗'])
  expect(head('Blocked')).toContain('todo')
  expect(head('Erledigt')).toContain('done')
  expect(head('Doing')).toContain('in progress')
  expect(head('Backlog')).not.toContain('backlog')
  expect(head('Cancelled')).not.toContain('(cancelled)')
  // Erledigt is closed though not last: cut to the newest few, newest first.
  const erledigt = rows.flatMap(r => (r.kind === 'rel' && /^CAT-1\d$/.test(r.item.target.key) ? [r.item.target.key] : []))
  expect(erledigt).toEqual(['CAT-15', 'CAT-14', 'CAT-13', 'CAT-12', 'CAT-11'])
  // Digits: in flight (Blocked is todo, Doing), then the backlog, then the closed columns.
  const d = digits(rows)
  expect([d['CAT-2'], d['CAT-3'], d['CAT-1']]).toEqual([1, 2, 3])
})

test('ZCC-5 marks by category: the category wins over the name and the position; an unknown category falls back', async () => {
  expect(markOf('Done', false, { category: 'cancelled', isFirst: false, isLast: false }).s).toBe('⊗')
  expect(markOf('Blocked', false, { category: 'todo', isFirst: false, isLast: false }).s).toBe('○')
  expect(markOf('Cancelled', false, { category: 'cancelled', isFirst: false, isLast: true }).s).toBe('⊗')
  expect(markOf('Erledigt', false, { category: 'done', isFirst: false, isLast: false }).s).toBe('●')
  expect(markOf('Done', false, { category: null, isFirst: false, isLast: false }).s).toBe('●')
  const t = parseTask(JSON.stringify({ ...TASK, column: 'Doing', column_category: 'later' }))
  expect([t.category, markOf(t.column, false, t).s]).toEqual([null, '◐'])
  expect(parseTask(JSON.stringify(TASK)).relations.map(r => r.category)).toEqual(['in_progress', 'backlog', 'review'])
})
