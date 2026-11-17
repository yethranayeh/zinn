// The guard cases, against the kit's stubbed engine (no model, no real Bash).
// The stub's tool.call bottom stands in for the engine spawning the shell: it records what the
// environment held at that moment, which is what a real child would have copied (a child's environment is copied at spawn).
import { test, expect, type Engine } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

// The kit runs tests where timers exist. The hooks environment's declarations do not list them.
declare const setTimeout: (f: () => void, ms: number) => unknown

type Env = Record<string, string>
type World = {
  env: Map<string, string | undefined>
  session: { id: string }
  /** what each shell call saw at its spawn, by command */
  spawned: Map<string, Env>
  /** gates holding a call in flight, by command */
  hold: Map<string, Promise<void>>
  steps: unknown[]
}

const ZINN = (env: Map<string, string | undefined>): Env => {
  const o: Env = {}
  for (const [k, v] of env) if (k.startsWith('ZINN_') && v !== undefined) {
    o[k] = v
  }
  return o
}

function world(on: On, sessionId = 'sess-1'): World {
  const w: World = { env: new Map(), session: { id: sessionId }, spawned: new Map(), hold: new Map(), steps: [] }
  on('env.get', async (_$, e) => ({ value: w.env.get(e.name) }))
  on('env.set', async (_$, e) => {
    if (e.value === undefined) {
      w.env.delete(e.name)
    } else {
      w.env.set(e.name, e.value)
    }
    return { value: {} } as never
  })
  on('session.id', async () => ({ value: w.session.id }))
  on('session.model', async () => ({ value: 'claude-main-fallback' }))
  on('agent.list', async () => ({ value: [] }))
  on('fs.write', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', async () => ({}))
  on('classic.UserPromptSubmit', async () => ({}))
  on('classic.SubagentStop', async () => ({}))
  on('agent.spawn', async (_$, e) => (w.spawned.set(`spawn:${e.description}`, ZINN(w.env)), { model: e.subagentType === 'Explore' ? 'claude-haiku-x' : 'claude-sonnet-x', agentId: `agent-${e.description}` }))
  on('turn.step', async function* (_$, e) {
    w.steps.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('tool.call', async (_$, e) => {
    const command = (e as { command?: string }).command ?? ''
    w.spawned.set(command, ZINN(w.env))
    const gate = w.hold.get(command)
    if (gate !== undefined) {
      await gate
    }
    return { result: { stdout: '', stderr: '', interrupted: false } as never, text: 'ok' }
  })
  return w
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
}

async function step($: Engine, model: string, effort: TurnStepInput['effort'], agentId?: string): Promise<void> {
  const s = $.turn.step({ turnId: 't1', index: 0, model, ...(effort === undefined ? {} : { effort }), messageCount: 3, ...(agentId === undefined ? {} : { agentId }) })
  for await (const _ of s) { /* drain */ }
  await s.result
}

async function spawn($: Engine, description: string, subagentType: string): Promise<string> {
  const r = await $.agent.spawn({ tool_use_id: `tu-${description}`, prompt: 'p', description, subagentType, provider: { plugin: 'engine', tier: 'core' } } as never)
  return r.agentId as string
}

const bash = ($: Engine, command: string, agentId?: string): Promise<unknown> =>
  $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) } as never)

const tick = (): Promise<void> => new Promise<void>(r => { setTimeout(() => r(), 1) })

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>(r => { open = r })
  return { promise, open }
}

test('main loop: session, model and effort declared; no thread, no agent', async ($, on) => {
  const w = world(on)
  await start($)
  expect(ZINN(w.env)).toEqual({ ZINN_SESSION_ID: 'sess-1' })
  await step($, 'claude-opus-5-5', 'high')
  await bash($, 'main-1')
  expect(w.spawned.get('main-1')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_MODEL: 'claude-opus-5-5', ZINN_EFFORT: 'high' })
  // between calls only the session stays
  expect(ZINN(w.env)).toEqual({ ZINN_SESSION_ID: 'sess-1' })
})

test('main loop before any step: the session model stands in, effort unset', async ($, on) => {
  const w = world(on)
  await start($)
  await bash($, 'main-0')
  expect(w.spawned.get('main-0')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_MODEL: 'claude-main-fallback' })
})

test('subagent: thread = agentId, plus agent, model, effort and the same session', async ($, on) => {
  const w = world(on)
  await start($)
  await step($, 'claude-opus-5-5', 'low')
  const id = await spawn($, 'one', 'Explore')
  await step($, 'claude-haiku-4-5', 'high', id)
  await bash($, 'sub-1', id)
  expect(w.spawned.get('sub-1')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_THREAD_ID: id, ZINN_AGENT: 'Explore', ZINN_MODEL: 'claude-haiku-4-5', ZINN_EFFORT: 'high' })
  // and the main loop afterwards is the main loop's again
  await bash($, 'main-2')
  expect(w.spawned.get('main-2')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_MODEL: 'claude-opus-5-5', ZINN_EFFORT: 'low' })
})

test('subagent with a model that takes no effort: effort unset, not the parent\'s', async ($, on) => {
  const w = world(on)
  await start($)
  await step($, 'claude-opus-5-5', 'high')
  const id = await spawn($, 'two', 'general-purpose')
  await step($, 'some-model-without-effort', undefined, id)
  await bash($, 'sub-2', id)
  expect(w.spawned.get('sub-2')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_THREAD_ID: id, ZINN_AGENT: 'general-purpose', ZINN_MODEL: 'some-model-without-effort' })
})

test('concurrent loops: the call that starts while another loop\'s call is in flight gets no per-loop value', async ($, on) => {
  const w = world(on)
  await start($)
  await step($, 'claude-opus-5-5', 'high')
  const a = await spawn($, 'a', 'Explore')
  const b = await spawn($, 'b', 'general-purpose')
  await step($, 'claude-haiku-4-5', 'low', a)
  await step($, 'claude-sonnet-4-6', 'medium', b)
  const ga = deferred()
  const gb = deferred()
  w.hold.set('A', ga.promise)
  w.hold.set('B', gb.promise)
  const pa = bash($, 'A', a)
  while (!w.spawned.has('A')) await tick()
  const pb = bash($, 'B', b)
  while (!w.spawned.has('B')) await tick()
  const pm = bash($, 'M')
  while (!w.spawned.has('M')) await tick()
  // A started alone: its own values. B and M started while another loop was in flight: session only.
  expect(w.spawned.get('A')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_THREAD_ID: a, ZINN_AGENT: 'Explore', ZINN_MODEL: 'claude-haiku-4-5', ZINN_EFFORT: 'low' })
  expect(w.spawned.get('B')).toEqual({ ZINN_SESSION_ID: 'sess-1' })
  expect(w.spawned.get('M')).toEqual({ ZINN_SESSION_ID: 'sess-1' })
  ga.open()
  gb.open()
  await Promise.all([pa, pb, pm])
  expect(ZINN(w.env)).toEqual({ ZINN_SESSION_ID: 'sess-1' })
})

test('concurrent loops: once the other loop\'s call ends, a lone loop is declared again', async ($, on) => {
  const w = world(on)
  await start($)
  const a = await spawn($, 'a', 'Explore')
  const b = await spawn($, 'b', 'Plan')
  await step($, 'm-a', 'low', a)
  await step($, 'm-b', 'max', b)
  const ga = deferred()
  w.hold.set('A1', ga.promise)
  const pa = bash($, 'A1', a)
  while (!w.spawned.has('A1')) await tick()
  await bash($, 'B1', b) // conflict: unset
  expect(w.spawned.get('B1')).toEqual({ ZINN_SESSION_ID: 'sess-1' })
  await bash($, 'A2', a) // only loop a in flight (A1): a's values
  expect(w.spawned.get('A2')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_THREAD_ID: a, ZINN_AGENT: 'Explore', ZINN_MODEL: 'm-a', ZINN_EFFORT: 'low' })
  ga.open()
  await pa
  await bash($, 'B2', b) // alone now
  expect(w.spawned.get('B2')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_THREAD_ID: b, ZINN_AGENT: 'Plan', ZINN_MODEL: 'm-b', ZINN_EFFORT: 'max' })
})

test('two calls of the same loop in parallel both carry that loop', async ($, on) => {
  const w = world(on)
  await start($)
  const a = await spawn($, 'a', 'Explore')
  await step($, 'm-a', 'low', a)
  const g = deferred()
  w.hold.set('P1', g.promise)
  const p1 = bash($, 'P1', a)
  while (!w.spawned.has('P1')) await tick()
  await bash($, 'P2', a)
  expect(w.spawned.get('P2')).toEqual(w.spawned.get('P1'))
  expect(w.spawned.get('P2')!['ZINN_THREAD_ID']).toBe(a)
  g.open()
  await p1
})

test('turn.step is passed through unchanged, input and result', async ($, on) => {
  const w = world(on)
  await start($)
  const input = { turnId: 't9', index: 4, model: 'claude-opus-5-5', effort: 'xhigh' as const, messageCount: 12, agentId: 'agent-z' }
  const s = $.turn.step(input)
  const chunks: unknown[] = []
  let it = await s.next()
  while (it.done !== true) { chunks.push(it.value); it = await s.next() }
  const r = it.value
  expect(w.steps).toEqual([input])
  expect(r).toEqual({ turnId: 't9', index: 4, answer: '', toolUses: [], stopReason: 'end_turn', usage: null })
  expect(chunks).toEqual([])
})

test('/clear: the old id is withdrawn at once, the next shell call carries the new id and no old loop', async ($, on) => {
  const w = world(on)
  await start($)
  const a = await spawn($, 'a', 'Explore')
  await step($, 'm-a', 'low', a)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} } as never)
  expect(ZINN(w.env)).toEqual({})
  w.session.id = 'sess-2'
  await step($, 'claude-opus-5-5', 'medium')
  await bash($, 'after-clear')
  expect(w.spawned.get('after-clear')).toEqual({ ZINN_SESSION_ID: 'sess-2', ZINN_MODEL: 'claude-opus-5-5', ZINN_EFFORT: 'medium' })
  // an agentId of the old conversation has no remembered type any more
  await bash($, 'old-loop', a)
  expect(w.spawned.get('old-loop')).toEqual({ ZINN_SESSION_ID: 'sess-2', ZINN_THREAD_ID: a })
})

test('the session id is refreshed on every shell call (a resume in-process)', async ($, on) => {
  const w = world(on)
  await start($)
  w.session.id = 'sess-resumed'
  await bash($, 'x')
  expect(w.spawned.get('x')!['ZINN_SESSION_ID']).toBe('sess-resumed')
})

test('the command is never rewritten and AI_AGENT is never written', async ($, on) => {
  const seen: string[] = []
  // registered first, so it sits above the stub's bottom and sees what the plugin passed down
  on('tool.call', { tool: 'Bash' }, async (_$, e, next) => { seen.push((e as { command: string }).command); return next(e) })
  const w = world(on)
  w.env.set('AI_AGENT', 'claude-code_2-1-302_agent')
  await start($)
  await bash($, "echo 'it''s' $HOME `x`")
  expect(seen).toEqual(["echo 'it''s' $HOME `x`"])
  expect(w.env.get('AI_AGENT')).toBe('claude-code_2-1-302_agent')
})

test('inherited ZINN_* from the parent process are replaced, never passed on as this session\'s', async ($, on) => {
  const w = world(on)
  w.env.set('ZINN_THREAD_ID', 'from-an-outer-host')
  w.env.set('ZINN_AGENT', 'outer')
  w.env.set('ZINN_SESSION_ID', 'outer-session')
  await start($)
  expect(ZINN(w.env)).toEqual({ ZINN_SESSION_ID: 'sess-1' })
})

test('off: nothing is written', { options: { enabled: false } }, async ($, on) => {
  const w = world(on)
  await start($)
  await bash($, 'off')
  expect(w.spawned.get('off')).toEqual({})
})

test('--agent session: the main loop carries the agent type from classic SessionStart, still no thread', async ($, on) => {
  const w = world(on)
  await start($)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'zinn-probe' })
  await step($, 'claude-opus-5-5', 'low')
  await bash($, 'agent-main')
  expect(w.spawned.get('agent-main')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_AGENT: 'zinn-probe', ZINN_MODEL: 'claude-opus-5-5', ZINN_EFFORT: 'low' })
  // a subagent of that session keeps its own type
  const id = await spawn($, 'k', 'Explore')
  await step($, 'claude-haiku-4-5', 'high', id)
  await bash($, 'agent-sub', id)
  expect(w.spawned.get('agent-sub')!['ZINN_AGENT']).toBe('Explore')
})

test('a classic event fired from inside a subagent never sets the main loop\'s agent', async ($, on) => {
  const w = world(on)
  await start($)
  await $.classic.UserPromptSubmit({ prompt: 'p', agent_id: 'agent-x', agent_type: 'general-purpose' } as never)
  await bash($, 'plain-main')
  expect(w.spawned.get('plain-main')!['ZINN_AGENT']).toBeUndefined()
})

test('/clear: classic SessionStart (source clear) puts the new id in place before any shell call', async ($, on) => {
  const w = world(on)
  await start($)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} } as never)
  w.session.id = 'sess-2'
  await $.classic.SessionStart({ source: 'clear' })
  expect(ZINN(w.env)).toEqual({ ZINN_SESSION_ID: 'sess-2' })
})

test('PowerShell calls get the same guard as Bash', async ($, on) => {
  const w = world(on)
  await start($)
  const a = await spawn($, 'a', 'Explore')
  await step($, 'm-a', 'low', a)
  const g = deferred()
  w.hold.set('PS-A', g.promise)
  const pa = $.tool.call({ tool: 'PowerShell', command: 'PS-A', agentId: a } as never)
  while (!w.spawned.has('PS-A')) await tick()
  await bash($, 'main-during-ps')
  expect(w.spawned.get('PS-A')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_THREAD_ID: a, ZINN_AGENT: 'Explore', ZINN_MODEL: 'm-a', ZINN_EFFORT: 'low' })
  expect(w.spawned.get('main-during-ps')).toEqual({ ZINN_SESSION_ID: 'sess-1' })
  g.open()
  await pa
})

test('a subagent start holds: its MCP servers (started before its first step) never copy another loop', async ($, on) => {
  const w = world(on)
  await start($)
  const a = await spawn($, 'a', 'Explore')
  await step($, 'm-a', 'low', a)
  const g = deferred()
  w.hold.set('A-long', g.promise)
  const pa = bash($, 'A-long', a)
  while (!w.spawned.has('A-long')) await tick()
  expect(ZINN(w.env)['ZINN_THREAD_ID']).toBe(a) // a alone in flight: declared
  const b = await spawn($, 'b', 'envdump')
  // during the spawn, and after it resolved until b's first step, nothing per-loop is in the environment
  expect(w.spawned.get('spawn:b')).toEqual({ ZINN_SESSION_ID: 'sess-1' })
  expect(ZINN(w.env)).toEqual({ ZINN_SESSION_ID: 'sess-1' })
  await step($, 'm-b', 'high', b)
  await tick()
  expect(ZINN(w.env)['ZINN_THREAD_ID']).toBe(a) // released: a alone again
  g.open()
  await pa
})

test('a subagent that stops before any step releases its hold', async ($, on) => {
  const w = world(on)
  await start($)
  const b = await spawn($, 'b', 'general-purpose')
  await $.classic.SubagentStop({ agent_id: b, agent_type: 'general-purpose', stop_hook_active: false, agent_transcript_path: '/tmp/x' } as never)
  await tick()
  await step($, 'm', 'low')
  await bash($, 'after-stop')
  expect(w.spawned.get('after-stop')).toEqual({ ZINN_SESSION_ID: 'sess-1', ZINN_MODEL: 'm', ZINN_EFFORT: 'low' })
})

// Not kit-testable: the kit refuses a test hook's $.mcp.connect ("its hooks module does not call it",
// host rule), and the engine-side $ has no mcp noun. The mcp.connect hold is covered by validate + tsc only.
