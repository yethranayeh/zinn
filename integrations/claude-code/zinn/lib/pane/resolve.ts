// What a command line or a selection asks the pane to show. Pure.

export const LAYOUTS = ['card', 'sectioned', 'table'] as const
export type Layout = (typeof LAYOUTS)[number]
export const isLayout = (s: string): s is Layout => (LAYOUTS as readonly string[]).includes(s)

/** A project key as Zinn spells it: letters and digits, starts with a letter. Stored upper case. */
const PROJECT_SOURCE = '[A-Z][A-Z0-9]{0,15}'
/** A task key: the project, a dash, a number. */
const KEY_SOURCE = `${PROJECT_SOURCE}-[0-9]{1,6}`
const KEY_EXACT = new RegExp(`^${KEY_SOURCE}$`)
const PROJECT_EXACT = new RegExp(`^${PROJECT_SOURCE}$`)
// Same boundaries as the transcript decorations: not inside a slug, a version, a URL path or a file name.
const KEY_IN_TEXT = new RegExp(`(?<![A-Za-z0-9_\\-.#=@\\\\])(${KEY_SOURCE})(?![A-Za-z0-9_]|-[A-Za-z0-9]|\\.[A-Za-z0-9])`, 'g')

/** How many key-shaped tokens of a selection are tried against the store, in order. */
export const MAX_TRIES = 4

/** Every key-shaped token of a text, in order, each once. */
export function candidateKeys(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(KEY_IN_TEXT)) seen.add(m[1]!)
  return [...seen]
}

export type ParsedArgs = { key: string | null; project: string | null; layout: Layout | null; bad: string | null }

/**
 * `/zinn-show [KEY | PROJECT] [layout]` in any order; a key may be typed in lower case. A layout name wins
 * over a project of the same name (a board keyed CARD is reached from the list of boards). `bad` is the first
 * word that is none of the three.
 */
export function parseArgs(args: string): ParsedArgs {
  let key: string | null = null
  let project: string | null = null
  let layout: Layout | null = null
  let bad: string | null = null
  for (const w of args.trim().split(/\s+/).filter(Boolean)) {
    const lower = w.toLowerCase()
    const upper = w.toUpperCase()
    if (isLayout(lower)) {
      layout = lower
    } else if (KEY_EXACT.test(upper)) {
      key = upper
    } else if (PROJECT_EXACT.test(upper)) {
      project = project ?? upper
    } else if (bad === null) {
      bad = w
    }
  }
  return { key, project, layout, bad }
}

export type Target =
  /** One task. From a selection there may be several candidates: the first one the store has is shown. */
  | { kind: 'task'; keys: string[]; from: 'argument' | 'selection' }
  | { kind: 'board'; project: string; from: 'argument' | 'selection' }
  /** Nothing named and nothing selected: the list of boards. */
  | { kind: 'projects' }
  | { kind: 'none'; message: string }

/**
 * An argument first (a task key before a project key), then the selection, then the list of boards. The store
 * judges a key: this only reads the words. A selection is searched for task keys; a selection that is exactly
 * one project key, as typed (never upper-cased: `the` is not a board), names that board.
 */
export function resolveTarget(a: { args: ParsedArgs; selection: string | undefined }): Target {
  if (a.args.bad !== null) {
    return { kind: 'none', message: `zinn-show: "${a.args.bad.slice(0, 40)}" is not a task key, a project key or a layout (card, sectioned, table)` }
  }
  if (a.args.key !== null) {
    return { kind: 'task', keys: [a.args.key], from: 'argument' }
  }
  if (a.args.project !== null) {
    return { kind: 'board', project: a.args.project, from: 'argument' }
  }
  const selection = (a.selection ?? '').trim()
  if (selection === '') {
    return { kind: 'projects' }
  }
  const cands = candidateKeys(selection)
  if (cands.length > 0) {
    return { kind: 'task', keys: cands.slice(0, MAX_TRIES), from: 'selection' }
  }
  if (PROJECT_EXACT.test(selection)) {
    return { kind: 'board', project: selection, from: 'selection' }
  }
  return { kind: 'none', message: 'zinn-show: no Zinn task key in the selection' }
}
