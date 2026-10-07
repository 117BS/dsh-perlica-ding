// The std facet must survive a host that hands it a std ActivationContext (which
// exposes no product services) and must never fail the host's boot. The guard is
// load-bearing: passing that context to the engine throws, which is exactly the
// defect T13 found on a std-only boot (2026-10-07).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep every state file this suite may write inside a temp home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'perlica-facet-'))

const { activate, deactivate, snapshot, MISSING_HOST_CAPABILITY } = await import('../lib/host/facet-std.mjs')
const { activateHost, activationState } = await import('../lib/host/activate.mjs')

/**
 * A std ActivationContext as @dsh-std/lifecycle builds it: a CleanupScope-shaped
 * object plus identity/plan/protocols/extensions — and no product context. Written
 * literally so this suite needs no @dsh-std package installed.
 */
function stdActivationContext() {
  return Object.freeze({
    identity: { component: 'terra.endfield.perlica-ding', version: '0.3.0', facet: 'host', instanceId: 'i-1', participantId: 'p-1' },
    plan: { revision: 'r-1', selected: [], activationOrder: [], compatible: true },
    scope: { add: () => {}, close: async () => {}, abort: () => {}, signal: { aborted: false } },
    protocols: { agreement: {}, client: () => undefined, implement: () => () => {} },
    extensions: { publish: () => () => {} },
  })
}

/** A minimal product context, the shape the native channel receives. */
function productContext() {
  const listeners = new Map()
  return {
    logger: () => ({ warn() {}, error() {}, info() {} }),
    get: (name) => (name === 'subprocess' ? { spawn: () => ({ done: Promise.resolve({ code: 0 }) }) } : undefined),
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    inject: (_deps, callback) => callback({ effect: (factory) => void factory(), webServer: { register: () => () => {} } }),
    effect: (factory) => factory(),
    listeners,
  }
}

test('the guard is load-bearing: the raw std context really does break the engine', async () => {
  // Negative control for the case below — this is the T13 crash, reproduced.
  await assert.rejects(activateHost(stdActivationContext().scope, undefined, { channel: 'std' }))
  assert.equal(activationState(), null, 'a failed activation must release the token, not poison it')
})

test('a std-only host gets a diagnosis, not a crash', async () => {
  await activate(stdActivationContext())
  const state = snapshot()
  assert.equal(state.state, 'degraded')
  assert.equal(state.message, MISSING_HOST_CAPABILITY)
  assert.equal(activationState(), null, 'the facet must not claim the activation token')
})

test('deactivate after a diagnosed gap stays a no-op', async () => {
  await activate(stdActivationContext())
  await deactivate('host unmounted')
  assert.equal(snapshot().state, 'degraded')
})

test('when the native channel is live the facet reports the component as active', async () => {
  const ctx = productContext()
  const dispose = await activateHost(ctx, undefined, { channel: 'native' })
  assert.equal(snapshot().state, 'active', 'an undefined config must fall back to the shared defaults')
  await activate(stdActivationContext())
  assert.equal(snapshot().state, 'active', 'a std host that also loads the bundle must not look degraded')
  await dispose()
  assert.equal(snapshot().state, 'degraded', 'with nothing live the component is degraded again')
})

test('a runnable context still reaches the engine (the facet is not dead code)', async () => {
  const ctx = productContext()
  await activate({ scope: ctx })
  assert.equal(activationState(), 'std')
  assert.equal(snapshot().state, 'active')
  await deactivate('test over')
  assert.equal(activationState(), null)
})
