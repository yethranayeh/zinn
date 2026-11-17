// One task as `zinn task view KEY --json` prints it, reduced to what the pane draws. Pure: nothing here
// imports the engine module.

export type RelationType = 'related' | 'dependency' | 'duplicate' | 'subtask'

export type Relation = {
  type: string
  direction: 'outgoing' | 'incoming'
  /** What the relation means for THIS task, in words: "depends on", "blocks", "subtask of", "subtasks". */
  verb: string
  key: string
  column: string
  /** Where that column sits on its board (the CLI's `is_first` / `is_last`), for a column the mark table does not name. */
  isFirst: boolean
  isLast: boolean
  title: string
  isArchived: boolean
}

export type Comment = {
  /** `ABC-19#3`, as the CLI names it. */
  key: string
  /** Cut to COMMENT_MAX characters. */
  text: string
  /** Epoch milliseconds. Null when the CLI gave none. */
  createdAt: number | null
}

export type TaskView = {
  key: string
  title: string
  /** 'Active' | 'Archived' (the lifecycle, not the board column). */
  status: string
  column: string
  isFirst: boolean
  isLast: boolean
  priority: string
  labels: string[]
  relations: Relation[]
  /** The description, cut to DESCRIPTION_MAX. The layouts cut it further. */
  description: string
  /** Every comment the task has. `comments` holds the newest COMMENTS_KEPT of them. */
  commentCount: number
  /** Newest first. */
  comments: Comment[]
  dueAt: number | null
  updatedAt: number | null
}

/** What the pane keeps of one task. The value lives in `$.state` for the session, so it has a ceiling. */
export const COMMENTS_KEPT = 30
export const COMMENT_MAX = 4000
export const DESCRIPTION_MAX = 20000

const VERBS: Record<string, Record<'outgoing' | 'incoming', string>> = {
  dependency: { outgoing: 'depends on', incoming: 'blocks' },
  subtask: { outgoing: 'subtask of', incoming: 'subtasks' },
  duplicate: { outgoing: 'duplicate of', incoming: 'duplicated by' },
  related: { outgoing: 'related', incoming: 'related' },
}

export const verbOf = (type: string, direction: 'outgoing' | 'incoming'): string => VERBS[type]?.[direction] ?? `${type} ${direction}`

export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter((l): l is string => typeof l === 'string') : [])
const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…')

/** The project half of a task key: `ABC-8` -> `ABC`. */
export const projectOf = (key: string): string => key.slice(0, Math.max(0, key.lastIndexOf('-')))

/** Parses the CLI's JSON. Throws a short reason on anything that is not a task. */
export function parseTask(stdout: string): TaskView {
  const d: unknown = JSON.parse(stdout)
  if (typeof d !== 'object' || d === null || Array.isArray(d)) {
    throw new Error('expected a JSON object')
  }
  const r = d as Record<string, unknown>
  if (typeof r['key'] !== 'string') {
    throw new Error('no key in the answer')
  }
  const relations: Relation[] = []
  if (Array.isArray(r['relations'])) {
    for (const x of r['relations'] as unknown[]) {
      if (typeof x !== 'object' || x === null) {
        continue
      }
      const rel = x as Record<string, unknown>
      const t = (typeof rel['task'] === 'object' && rel['task'] !== null ? rel['task'] : {}) as Record<string, unknown>
      // `related` has no direction (the CLI prints null): it reads the same from both ends.
      const direction = rel['direction'] === 'incoming' ? 'incoming' : 'outgoing'
      if (typeof t['key'] !== 'string') {
        continue
      }
      relations.push({
        type: str(rel['type']), direction, verb: verbOf(str(rel['type']), direction), key: t['key'], column: str(t['column']),
        isFirst: t['is_first'] === true, isLast: t['is_last'] === true, title: str(t['title']), isArchived: t['status'] === 'Archived',
      })
    }
  }
  const all: Comment[] = []
  if (Array.isArray(r['comments'])) {
    for (const x of r['comments'] as unknown[]) {
      if (typeof x !== 'object' || x === null) {
        continue
      }
      const c = x as Record<string, unknown>
      all.push({ key: str(c['key']), text: clip(str(c['text']), COMMENT_MAX), createdAt: num(c['created_at']) })
    }
  }
  return {
    key: r['key'],
    title: str(r['title']),
    status: str(r['status']),
    column: str(r['column']),
    isFirst: r['is_first'] === true,
    isLast: r['is_last'] === true,
    priority: str(r['priority']),
    labels: strings(r['labels']),
    relations,
    description: clip(str(r['description']), DESCRIPTION_MAX),
    commentCount: all.length,
    // The CLI lists comments oldest first; the pane reads the newest first.
    comments: all.slice(-COMMENTS_KEPT).reverse(),
    dueAt: num(r['due_at']),
    updatedAt: num(r['updated_at']),
  }
}

/** Why a `zinn` run gave nothing: the envelope's `code` (never its message) is what a caller branches on. */
export type Failure = { code: string | null; reason: string }

/** Reads the CLI's failure. Its `--json` errors go to stderr as `{"error":{"code","message",...}}`. */
export function failureOf(r: { exitCode: number; stderr: string; isStdoutTruncated?: boolean }): Failure {
  if (r.isStdoutTruncated) {
    return { code: null, reason: 'output over 4 MiB' }
  }
  let why = ''
  let code: string | null = null
  try {
    const e = JSON.parse(r.stderr) as { error?: { code?: unknown; message?: unknown } }
    if (e && e.error) {
      if (typeof e.error.message === 'string') {
        why = e.error.message
      }
      if (typeof e.error.code === 'string') {
        code = e.error.code
      }
    }
  } catch { why = r.stderr.trim().split('\n')[0] ?? '' }
  return { code, reason: `exit ${r.exitCode}${why ? ': ' + why.slice(0, 120) : ''}` }
}

/** The one-line reason a `zinn` run gave no task. */
export const failureReason = (r: { exitCode: number; stderr: string; isStdoutTruncated?: boolean }): string => failureOf(r).reason

/**
 * The first paragraph of a description, as plain text. The `meta.*` footer lines (this repo's extension
 * point for fields Zinn lacks) and a `---` rule end the body; a list's first lines stay one paragraph.
 * Cut at `max` characters with an ellipsis that counts as one.
 */
export function firstParagraph(description: string, max: number): { text: string; isCut: boolean } {
  const lines = description.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '---' || /^meta\.[a-z_.]+:/.test(line)) {
      break
    }
    if (line === '') {
      if (out.length > 0) {
        break
      }
      continue
    }
    out.push(line)
  }
  const joined = out.join(' ').replace(/\s+/g, ' ')
  if (max > 0 && joined.length > max) {
    return { text: joined.slice(0, Math.max(0, max - 1)).trimEnd() + '…', isCut: true }
  }
  return { text: joined, isCut: false }
}
