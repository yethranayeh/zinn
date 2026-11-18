// What the CLI prints, as fixtures. A task as `zinn task view KEY --json` prints it
// (shape measured at 0.40.x. `is_first`, `is_last`, `due_at`, numeric `created_at` re-read at 0.44.0. `column_category`,
// `category` and `claim` re-read at 0.46.0-dev), a project as `zinn project view KEY --json`, its tasks as `zinn task list KEY --json`, and
// the boards as `zinn project list --json`. Not a store: the tests never touch one (process.run is stubbed).
export const LONG = 'A '.repeat(400).trim()

const DAY = 86_400_000
/** 2026-10-12T09:00:00Z. */
export const T0 = Date.UTC(2026, 9, 12, 9, 0, 0)

export const TASK = {
  key: 'ZCC-8',
  status: 'Active',
  column: 'In Progress',
  is_first: false,
  is_last: false,
  column_category: 'in_progress',
  claim: null,
  title: 'Task detail pane: /zinn task with no argument reads the selection; zero tokens',
  description: "OpenCode modal, done the Claude Code way.\n\n- `$.ui.open` a pane.\n\n---\nmeta.agent: sonnet (medium)",
  priority: 'medium',
  labels: ['frontend', 'pane'],
  due_at: null,
  updated_at: T0 + 2 * DAY,
  relations: [
    { type: 'dependency', direction: 'outgoing', task: { key: 'ZCC-6', column: 'In Progress', is_first: false, is_last: false, column_category: 'in_progress', title: 'Build key-lines MVP', status: 'Active' } },
    { type: 'dependency', direction: 'incoming', task: { key: 'ZCC-9', column: 'Backlog', is_first: true, is_last: false, column_category: 'backlog', title: 'Spike: hover card and link press', status: 'Active' } },
    { type: 'subtask', direction: 'incoming', task: { key: 'ZCC-16', column: 'Review', is_first: false, is_last: false, column_category: 'review', title: 'key-lines line polish', status: 'Active' } },
  ],
  comments: [
    { key: 'ZCC-8#1', text: 'First note: the pane **seats** at any width.', created_at: T0, updated_at: T0 },
    { key: 'ZCC-8#2', text: 'Agent picked `table`.', created_at: T0 + DAY, updated_at: T0 + DAY },
  ],
}

export const BARE = { key: 'ZCC-1', status: 'Archived', column: 'Done', is_first: false, is_last: true, column_category: 'done', claim: null, title: 'Survey', description: '', priority: 'low', labels: [], relations: [], comments: [] }

/** A task with a due date, in a column the name table does not name, from a store that gives no category. */
export const DUE = { ...BARE, key: 'ZCC-9', status: 'Active', column: 'Doing', column_category: undefined, is_last: false, title: 'Spike: hover card and link press', due_at: Date.UTC(2026, 10, 20), relations: [], comments: [] }

export const PROJECT = {
  key: 'ZCC',
  name: 'Claude Code mods',
  columns: [
    { name: 'Backlog', is_first: true, is_last: false, category: 'backlog', taskCount: 12 },
    { name: 'TODO', is_first: false, is_last: false, category: 'todo', taskCount: 0 },
    { name: 'In Progress', is_first: false, is_last: false, category: 'in_progress', taskCount: 2 },
    { name: 'Done', is_first: false, is_last: true, category: 'done', taskCount: 7 },
  ],
  archivedTaskCount: 1,
}

const CATEGORY_OF: Record<string, string> = { 'Backlog': 'backlog', 'In Progress': 'in_progress', 'Done': 'done' }

const row = (n: number, column: string, extra: Record<string, unknown> = {}) => ({
  key: `ZCC-${n}`, status: 'Active', column, column_category: CATEGORY_OF[column], claim: null, title: `Task number ${n}`, priority: 'medium', due_at: null, labels: [], updated_at: T0 + n * DAY, ...extra,
})

/** Twelve in the backlog (two more than a cut column shows), two in flight, seven done (two more than shown). */
export const BOARD_TASKS = [
  ...Array.from({ length: 12 }, (_, i) => row(100 + i, 'Backlog')),
  row(8, 'In Progress', { title: 'Task detail pane', priority: 'high', labels: ['frontend', 'pane'] }),
  row(6, 'In Progress', { title: 'Build key-lines MVP', priority: '', due_at: Date.UTC(2026, 10, 20) }),
  ...Array.from({ length: 7 }, (_, i) => row(200 + i, 'Done')),
]

export const PROJECTS = [
  { key: 'SAM', name: 'Sandboxes', description: 'trial', taskCounts: { active: 31, archived: 20 } },
  { key: 'ZCC', name: 'Claude Code mods', taskCounts: { active: 20, archived: 1 } },
  { key: 'TS', name: 'Text search tool', taskCounts: { active: 51, archived: 0 } },
]

export const NOT_FOUND = (what: string) => JSON.stringify({ error: { code: 'not_found', details: {}, message: `${what} not found` } }, null, 2)

/**
 * A board with the default columns of 0.46.0-dev, one renamed (`Erledigt`) and one whose category says other than
 * its name (`Blocked`, set to todo): the last column is Cancelled, so position alone would read it as done.
 */
export const CATEGORY_PROJECT = {
  key: 'CAT',
  name: 'Categories',
  columns: [
    { name: 'Backlog', is_first: true, is_last: false, category: 'backlog', taskCount: 1 },
    { name: 'Blocked', is_first: false, is_last: false, category: 'todo', taskCount: 1 },
    { name: 'Doing', is_first: false, is_last: false, category: 'in_progress', taskCount: 1 },
    { name: 'Review', is_first: false, is_last: false, category: 'review', taskCount: 0 },
    { name: 'Erledigt', is_first: false, is_last: false, category: 'done', taskCount: 6 },
    { name: 'Cancelled', is_first: false, is_last: true, category: 'cancelled', taskCount: 2 },
  ],
  archivedTaskCount: 0,
}

const catRow = (n: number, column: string, category: string) => ({ ...row(n, column), key: `CAT-${n}`, column_category: category })

export const CATEGORY_TASKS = [
  catRow(1, 'Backlog', 'backlog'),
  catRow(2, 'Blocked', 'todo'),
  catRow(3, 'Doing', 'in_progress'),
  ...Array.from({ length: 6 }, (_, i) => catRow(10 + i, 'Erledigt', 'done')),
  catRow(20, 'Cancelled', 'cancelled'),
  catRow(21, 'Cancelled', 'cancelled'),
]
