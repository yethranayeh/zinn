// The key map as the plain data this plugin publishes in `$.state` (plugin zinn, key `map`). Pure. The
// contract other plugins read is declared in types/index.d.ts, and hooks/mentions.tsx checks at compile
// time that the shape built here and the declared one are the same type.
import type { Category } from './columns'
import type { KeyMap } from './keys'

export type KeyEntry = { column: string; category: Category | null; title: string; isArchived: boolean }

export type KeyMapState = {
  /** `loading` until the first load settles. `failed` keeps the last error and no keys. */
  status: 'loading' | 'ready' | 'failed'
  /** Every key in the store, archived included (`zinn task list --all --json`), full titles. */
  keys: Record<string, KeyEntry>
  /** Project keys that have at least one task. A key-shaped token of another project is never judged. */
  projects: string[]
  archived: number
  /** ISO time the map was loaded (engine clock), null while loading. */
  loadedAt: string | null
  /** The argv that produced it, for the record. */
  argv: string[]
  /** Why the last load failed, one short line. Null when it did not. */
  error: string | null
}

export function toState(map: KeyMap | null, at: string | null, argv: readonly string[], error: string | null): KeyMapState {
  if (map === null) {
    return { status: error === null ? 'loading' : 'failed', keys: {}, projects: [], archived: 0, loadedAt: at, argv: [...argv], error }
  }
  const keys: Record<string, KeyEntry> = {}
  for (const [k, v] of map.keys) keys[k] = { column: v.column, category: v.category, title: v.title, isArchived: v.isArchived }
  return { status: 'ready', keys, projects: [...map.projects].sort(), archived: map.archived, loadedAt: at, argv: [...argv], error: null }
}

/** The one-line reason a `zinn` run did not give a key map, from its result (its --json errors go to stderr). */
export function failureReason(r: { exitCode: number; stderr: string; isStdoutTruncated: boolean }): string {
  if (r.isStdoutTruncated) {
    return 'output over 4 MiB'
  }
  let why = ''
  try {
    const e = JSON.parse(r.stderr) as { error?: { message?: unknown } }
    if (e && e.error && typeof e.error.message === 'string') {
      why = e.error.message
    }
  } catch { why = r.stderr.trim().split('\n')[0] ?? '' }
  return `exit ${r.exitCode}${why ? ': ' + why.slice(0, 120) : ''}`
}
