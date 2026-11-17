// zinn-identity: the pure half, no engine.
import { test, expect } from 'claude-code/testing'
import { NAMES, Tracker, clean, plan, type Declared, type Name } from '../lib/identity'

const unset: Declared = { ZINN_SESSION_ID: undefined, ZINN_THREAD_ID: undefined, ZINN_AGENT: undefined, ZINN_MODEL: undefined, ZINN_EFFORT: undefined }

test('clean: blank is unset, numbers become their text', () => {
  expect(clean('  x ')).toBe('x')
  expect(clean('   ')).toBeUndefined()
  expect(clean(undefined)).toBeUndefined()
  expect(clean(2048)).toBe('2048')
})

test('plan: setting writes the session before the thread', () => {
  const want: Declared = { ...unset, ZINN_SESSION_ID: 's', ZINN_THREAD_ID: 'a' }
  expect(plan({}, new Set(), want).map(w => w.name)).toEqual([...NAMES])
})

test('plan: unsetting the session writes it last, after the thread', () => {
  const known = new Set<Name>(NAMES)
  const last = { ZINN_SESSION_ID: 's', ZINN_THREAD_ID: 'a' }
  expect(plan(last, known, unset)).toEqual([{ name: 'ZINN_THREAD_ID', value: undefined }, { name: 'ZINN_SESSION_ID', value: undefined }])
})

test('plan: nothing to write when the environment already holds the target', () => {
  const known = new Set<Name>(NAMES)
  expect(plan({ ZINN_SESSION_ID: 's' }, known, { ...unset, ZINN_SESSION_ID: 's' })).toEqual([])
})

test('target: a thread is never declared without a session', () => {
  const t = new Tracker()
  t.spawned('agent-1', 'Explore', 'm')
  t.begin('agent-1')
  const r = t.target()
  expect(r.decision).toBe('no-session')
  expect(r.env).toEqual(unset)
})

test('target: a later spawn result does not overwrite a model a step reported', () => {
  const t = new Tracker()
  t.session = 's'
  t.stepped('agent-1', 'from-step', 'low')
  t.spawned('agent-1', 'Explore', 'from-spawn')
  t.begin('agent-1')
  expect(t.target().env.ZINN_MODEL).toBe('from-step')
})
