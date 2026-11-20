// Keeping the key map live. Pure: no engine import.
//
// Three small jobs, all plain data in and out:
//   1. classify(command): does a Bash command write to Zinn, and which keys does it touch?
//   2. applyView / dropKey: fold one `zinn task view KEY --json` answer into the key map.
//   3. newestActivityId / changedColumns: the poll's change detector and the toast's diff.
//
// THE RULE: never a wrong partial refresh. A command that is not parsed with certainty
// (compound pieces we do not understand, variables, command substitution, a heredoc, an unknown verb) is a
// FULL refresh. The cost of that rule is an occasional needless 260 ms CLI call. The cost of the opposite
// is a legend that lies. The classifier never decides to ignore a command it cannot read, if the command
// holds a zinn write.
import { keyInfoOf, projectOf, type KeyInfo, type KeyMap } from './keys'

export type Verdict =
  /** Not a zinn write (or no zinn at all): nothing to do. */
  | { kind: 'none' }
  /** A zinn write that touches exactly these keys: refresh them with `zinn task view KEY --json`. */
  | { kind: 'keys'; keys: string[] }
  /** A zinn write that cannot be pinned to keys, or a command that cannot be read with certainty. */
  | { kind: 'full'; why: string }

const KEY_ARG = /^[A-Z][A-Z0-9]{0,15}-[0-9]{1,6}$/

/** Group (the word after `zinn`) -> verbs that only read. Anything else under a group is treated as a write. */
const READ_VERBS: Record<string, readonly string[]> = {
  task: ['list', 'ls', 'search', 'view', 'show'],
  project: ['list', 'ls', 'view', 'show'],
  label: ['list', 'ls', 'view', 'show'],
  activity: ['list', 'ls', 'view', 'show'],
}
/** Subgroups ("task comment create"): the verbs that only read. */
const READ_SUB: Record<string, readonly string[]> = {
  'task relation': ['list', 'ls'],
  'task comment': ['list', 'ls', 'view', 'show'],
  'project column': ['list', 'ls'],
}
/** Subgroups that write to ONE task: the keys are in the arguments. */
const KEYED_SUB = new Set(['task relation', 'task comment', 'task label'])
/** Whole commands that never change a board. */
const READ_ONLY_TOP = new Set(['info', 'capabilities', 'backup', 'whoami', '-v', '--version', '-h', '--help', 'help'])
/**
 * Verbs of `zinn task` that change one or more named tasks, claims included. `create` and its alias `new` are not
 * here: the key is not in the argv. `rm` is the alias of `delete`.
 */
const KEYED_TASK_VERBS = new Set(['edit', 'move', 'order', 'archive', 'unarchive', 'delete', 'rm', 'claim', 'heartbeat', 'release'])

/** The shell, lexed just enough to split segments and see whether anything is uncertain. */
type Lexed = { segments: string[][]; uncertain: string | null }

function lex(command: string): Lexed {
  const segments: string[][] = []
  let cur: string[] = []
  let tok = ''
  let has = false
  let uncertain: string | null = null
  const flag = (why: string): void => {
    if (uncertain === null) {
      uncertain = why
    }
  }
  const endTok = (): void => {
    if (has) {
      cur.push(tok)
    }
    tok = ''
    has = false
  }
  const endSeg = (): void => {
    endTok()
    if (cur.length > 0) {
      segments.push(cur)
    }
    cur = []
  }
  let i = 0
  while (i < command.length) {
    const c = command[i]!
    const two = command.slice(i, i + 2)
    if (c === "'") {
      const j = command.indexOf("'", i + 1)
      if (j === -1) { flag('unterminated quote'); tok += command.slice(i + 1); has = true; break }
      tok += command.slice(i + 1, j); has = true; i = j + 1; continue
    }
    if (c === '"') {
      let j = i + 1
      let body = ''
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) { body += command[j + 1]; j += 2; continue }
        if (command[j] === '$' || command[j] === '`') {
          flag('substitution in a double quote')
        }
        body += command[j]; j++
      }
      if (j >= command.length) {
        flag('unterminated quote')
      }
      tok += body; has = true; i = j + 1; continue
    }
    if (c === '\\') {
      if (i + 1 < command.length && command[i + 1] === '\n') { i += 2; continue } // line continuation
      if (i + 1 < command.length) { tok += command[i + 1]; has = true }
      i += 2; continue
    }
    if (c === '$' || c === '`') { flag('variable or command substitution'); tok += c; has = true; i++; continue }
    if (c === '(' || c === ')') { flag('subshell'); endSeg(); i++; continue }
    if (c === '{' || c === '}') { flag('brace group or expansion'); tok += c; has = true; i++; continue }
    if (two === '<<') { flag('heredoc'); i += 2; continue }
    if (two === '&&' || two === '||') { endSeg(); i += 2; continue }
    if (c === ';' || c === '|' || c === '&' || c === '\n') { endSeg(); i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { endTok(); i++; continue }
    if (c === '>' || c === '<') { endTok(); i++; continue } // a redirect: its target is a word we then read as an argument. Harmless
    if (c === '#' && !has) { while (i < command.length && command[i] !== '\n') i++; continue }
    tok += c; has = true; i++
  }
  endSeg()
  return { segments, uncertain }
}

/** `zinn ...` written into another command (`bash -c "zinn task move X Done"`, `xargs zinn ...`). */
const EMBEDDED_WRITE = /\bzinn\s+(?:--?\S+\s+)*(?:(?:task|project|label)\s+(?:column\s+|relation\s+|comment\s+|label\s+)?(?:create|edit|move|order|archive|unarchive|delete|add|remove|rename)\b|restore\b|migrate\b|reindex\b)/

/** The first word `zinn` anywhere, as a word of its own. Cheap pre-filter: most Bash calls stop here. */
const HAS_ZINN = /(^|[^A-Za-z0-9_.\-/])zinn($|[^A-Za-z0-9_\-])/

/** Is this segment a call of `zinn`? Returns its arguments after the program, plus whether env assignments came first. */
function zinnArgs(seg: string[]): { args: string[]; envPrefix: boolean } | null {
  let i = 0
  while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i]!)) i++
  const prog = seg[i]
  if (prog === undefined) {
    return null
  }
  const base = prog.split('/').pop()!
  if (base !== 'zinn') {
    return null
  }
  return { args: seg.slice(i + 1), envPrefix: i > 0 }
}

/**
 * What a Bash command does to the Zinn store, as far as it can be read with certainty.
 * Never throws. See the RULE at the top of the file.
 */
export function classify(command: string): Verdict {
  if (!HAS_ZINN.test(command)) {
    return { kind: 'none' }
  }
  const { segments, uncertain } = lex(command)
  // Command substitution, variables or a heredoc may hide a zinn call or its keys: if zinn is named at all, full.
  if (uncertain !== null) {
    return { kind: 'full', why: uncertain }
  }
  const keys: string[] = []
  let full: string | null = null
  for (const seg of segments) {
    const z = zinnArgs(seg)
    if (z === null) {
      if (EMBEDDED_WRITE.test(seg.join(' '))) {
        full = full ?? 'zinn write inside another command'
      }
      continue
    }
    const words: string[] = []
    let flagsBeforeVerb = false
    for (const a of z.args) {
      if (a === '--') {
        break
      }
      if (a.startsWith('-')) {
        if (words.length < 2) {
          flagsBeforeVerb = true
        }
        continue
      }
      words.push(a)
    }
    const group = words[0]
    // Read-only top-level words need no further parsing. An env prefix (ZINN_DIR=...) may mean another store, which
    // we cannot judge, so it falls through to the write logic only when the verb is a write.
    if (group === undefined) {
      // `zinn -v`, `zinn --help`, `zinn --json`...: flags only.
      if (z.args.every(a => READ_ONLY_TOP.has(a) || a === '--json')) {
        continue
      }
      full = full ?? 'zinn with flags only'
      continue
    }
    if (READ_ONLY_TOP.has(group)) {
      continue
    }
    if (z.args.some(a => a === '--help' || a === '-h')) {
      continue
    } // --help runs nothing
    if (flagsBeforeVerb && words.length < 2) { full = full ?? 'flag before the verb'; continue }
    const subKey = `${group} ${words[1] ?? ''}`
    const hasSub = subKey in READ_SUB || KEYED_SUB.has(subKey)
    const verb = hasSub ? words[2] : words[1]
    const argStart = hasSub ? 3 : 2
    const reads = hasSub ? READ_SUB[subKey] : READ_VERBS[group]
    if (verb !== undefined && reads !== undefined && reads.includes(verb)) {
      continue
    } // a read; an env prefix does not change that
    // From here the segment is a write, or a verb we do not know.
    if (z.envPrefix) { full = full ?? 'env assignment before zinn (another store?)'; continue }
    if (group === 'task') {
      if (KEYED_SUB.has(subKey)) {
        const found = words.slice(argStart).filter(w => KEY_ARG.test(w))
        if (verb === undefined || found.length === 0) { full = full ?? `${subKey}: no key found`; continue }
        keys.push(...found)
        continue
      }
      if (verb !== undefined && KEYED_TASK_VERBS.has(verb)) {
        const found = words.slice(argStart).filter(w => KEY_ARG.test(w))
        if (found.length === 0) { full = full ?? `task ${verb}: no key found`; continue }
        keys.push(...found)
        continue
      }
      // task create (the new key is not in the argv), or a verb this mod does not know.
      full = full ?? `task ${verb ?? '?'}`
      continue
    }
    full = full ?? `${group} ${verb ?? ''}`.trim() // project / label writes, restore, migrate, reindex, unknown
  }
  if (full !== null) {
    return { kind: 'full', why: full }
  }
  if (keys.length > 0) {
    return { kind: 'keys', keys: [...new Set(keys)] }
  }
  return { kind: 'none' }
}

// ---- folding one `zinn task view KEY --json` into the map ------------------------------------------

export type ViewResult =
  | { kind: 'row'; info: KeyInfo }
  | { kind: 'gone' }
  /** Anything else (zinn did not run, a storage error, a shape we do not know): the caller falls back to a full refresh. */
  | { kind: 'unknown'; why: string }

/** The result of `zinn task view KEY --json` (stdout on 0, the stderr envelope on 1). */
export function readView(key: string, r: { exitCode: number; stdout: string; stderr: string }): ViewResult {
  if (r.exitCode === 0) {
    try {
      const row = JSON.parse(r.stdout) as { key?: unknown; column?: unknown; title?: unknown }
      const info = keyInfoOf(row)
      if (info === null || row.key !== key || typeof row.column !== 'string' || typeof row.title !== 'string') {
        return { kind: 'unknown', why: 'unexpected view shape' }
      }
      return { kind: 'row', info }
    } catch { return { kind: 'unknown', why: 'view is not JSON' } }
  }
  try {
    const env = JSON.parse(r.stderr) as { error?: { code?: unknown; details?: { entity?: unknown } } }
    // A deleted task: not_found for the task itself. A not_found for a project means the whole board is gone: full.
    if (env.error?.code === 'not_found' && env.error.details?.entity === 'task') {
      return { kind: 'gone' }
    }
  } catch { /* fall through */ }
  return { kind: 'unknown', why: `exit ${r.exitCode}` }
}

/** The result of `zinn task heartbeat KEY --json`. */
export type HeartbeatResult =
  /** Renewed: the task as the CLI printed it, with the new expiry. */
  | { kind: 'renewed'; info: KeyInfo }
  /** The CLI refused, by its error envelope's reason or code. */
  | { kind: 'refused'; reason: string; message: string }
  /** No answer to read: zinn did not run, or printed something else. */
  | { kind: 'failed'; why: string }

/** Reads a heartbeat's answer: the task on exit 0, as `task view` prints it, else the error envelope on stderr. */
export function readHeartbeat(key: string, r: { exitCode: number; stdout: string; stderr: string }): HeartbeatResult {
  if (r.exitCode === 0) {
    const view = readView(key, r)
    return view.kind === 'row' ? { kind: 'renewed', info: view.info } : { kind: 'failed', why: view.kind === 'unknown' ? view.why : 'no task' }
  }
  try {
    const env = JSON.parse(r.stderr) as { error?: { code?: unknown; message?: unknown; details?: { reason?: unknown } } }
    const code = env.error?.code
    if (typeof code === 'string') {
      const reason = env.error?.details?.reason
      const message = env.error?.message
      return { kind: 'refused', reason: typeof reason === 'string' ? reason : code, message: typeof message === 'string' ? message : code }
    }
  } catch { /* fall through */ }
  return { kind: 'failed', why: `exit ${r.exitCode}` }
}

/** The result of `zinn task release KEY --json`. A task that had no claim counts as released. */
export type ReleaseResult = { kind: 'released' } | Exclude<HeartbeatResult, { kind: 'renewed' }>

/** Reads a release's answer: it prints the task and the error envelope as a heartbeat does. */
export function readRelease(key: string, r: { exitCode: number; stdout: string; stderr: string }): ReleaseResult {
  const answer = readHeartbeat(key, r)
  return answer.kind === 'renewed' ? { kind: 'released' } : answer
}

/** A copy of the map with `results` folded in. `unknown` results must be handled by the caller first. */
export function applyViews(map: KeyMap, results: ReadonlyMap<string, ViewResult>): KeyMap {
  const keys = new Map(map.keys)
  for (const [key, res] of results) {
    if (res.kind === 'row') {
      keys.set(key, res.info)
    } else if (res.kind === 'gone') {
      keys.delete(key)
    }
  }
  const projects = new Set(map.projects) // a deleted last task keeps its project: the project still exists
  let archived = 0
  for (const [key, v] of keys) { projects.add(projectOf(key)); if (v.isArchived) {
    archived++
  } }
  return { keys, projects, archived }
}

/** Keys whose board column changed between two maps (both present). */
export function changedColumns(prev: KeyMap, next: KeyMap): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = []
  for (const [key, b] of next.keys) {
    const a = prev.keys.get(key)
    if (a !== undefined && a.column !== b.column) {
      out.push({ key, from: a.column, to: b.column })
    }
  }
  return out
}

/** `ABC-7 -> Review`, at most `max` of them, then `+N more`. */
export function toastText(changes: readonly { key: string; to: string }[], max = 3): string {
  const shown = changes.slice(0, max).map(c => `${c.key} -> ${c.to}`)
  const more = changes.length - shown.length
  return `zinn: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`
}

// ---- the poll ------------------------------------------------------------------------------------

/**
 * The newest activity id from `zinn activity list --limit 1 --json` (a bare array). Activity ids are UUIDv7, so
 * the newest is the one compared with the last seen. null when the log is empty or the output is not that.
 */
export function newestActivityId(stdout: string): string | null {
  try {
    const data: unknown = JSON.parse(stdout)
    if (!Array.isArray(data) || data.length === 0) {
      return null
    }
    const id = (data[0] as { id?: unknown } | null)?.id
    return typeof id === 'string' && id !== '' ? id : null
  } catch { return null }
}

/** `pollSeconds` from the option: whole seconds, 0 = off, default 30, a minimum of 5 when on. */
export const DEFAULT_POLL_SECONDS = 30
export const MIN_POLL_SECONDS = 5
export function parsePollSeconds(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_POLL_SECONDS
  }
  if (n === 0) {
    return 0
  }
  return Math.max(MIN_POLL_SECONDS, Math.floor(n))
}
