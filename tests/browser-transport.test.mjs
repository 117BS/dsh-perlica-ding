/**
 * dsh-perlica-ding — browser transport contract tests.
 *
 * These load the REAL client bundle (`lib/browser/index.js`) through a
 * `window.__ModuleLoader__` shim, exactly as the DSH client module system
 * would, with a `react` stub for the one specifier the bundle requires.
 * Nothing about the transport itself is mocked; `fetchImpl` is the only
 * injected seam, exactly as the module's interface intends.
 *
 * Run: node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const BUNDLE_ID = 'dsh-perlica-ding'
const ROUTE_MISSING_HEAD = '插件后台接口未就绪'
const ROUTE_MISSING_TAIL = '——请重启 DSH 后重试'

/** Capture the registration the real bundle performs. */
const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

/** The only specifier the bundle requires; the page is never rendered here. */
const reactStub = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

await import('../lib/browser/index.js')

test('registers exactly one factory under the package bundle id', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, BUNDLE_ID)
  assert.equal(typeof registrations[0].factory, 'function')
})

/** The bundle's public face, as the module system materializes it. */
const requested = []
const mod = registrations[0].factory((specifier) => {
  requested.push(specifier)
  if (specifier === 'react') return reactStub
  throw new Error('unexpected require: ' + specifier)
})

test('the bundle requires nothing beyond react', () => {
  assert.deepEqual(requested, ['react'])
})

test('the bundle exports the settings-page face and createTransport', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.PerlicaDingSettings, 'function')
  assert.equal(typeof mod.createTransport, 'function')
})

const createTransport = mod.createTransport

/** Build a fetch response stub carrying the given body. */
function jsonResponse(status, body, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  }
}

/** A recording fetch that answers from a queue of canned responses. */
function recordingFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected request: ' + url)
    if (next instanceof Error) throw next
    return next
  }
  return { impl, calls }
}

test('getState: 200 round trip, base default, normalized shape', async () => {
  const { impl, calls } = recordingFetch([
    jsonResponse(200, {
      volume: 60,
      enabled: true,
      debounceMs: 250,
      persistent: true,
      kind: 'P2',
      kinds: [
        { id: 'plan', label: '计划出方案' },
        { id: 'done', label: '任务完成' },
        { id: 'ask', label: '需要你回应' },
        { id: 'fail', label: '出错' },
      ],
    }),
  ])

  const transport = createTransport({ fetchImpl: impl })
  const state = await transport.getState()

  assert.deepEqual(state, {
    volume: 60,
    enabled: true,
    debounceMs: 250,
    persistent: true,
    kind: 'P2',
    kinds: [
      { id: 'plan', label: '计划出方案' },
      { id: 'done', label: '任务完成' },
      { id: 'ask', label: '需要你回应' },
      { id: 'fail', label: '出错' },
    ],
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/perlica-ding/api/state')
  assert.equal(calls[0].init.method, undefined)
})

test('getState: missing kind degrades to "none" and absent kinds to []', async () => {
  const { impl } = recordingFetch([jsonResponse(200, { volume: 0, persistent: false })])
  const state = await createTransport({ fetchImpl: impl }).getState()
  assert.equal(state.kind, 'none')
  assert.equal(state.persistent, false)
  assert.deepEqual(state.kinds, [])
})

test('getState: junk kind entries are dropped, and an unknown tier passes through', async () => {
  const { impl } = recordingFetch([
    jsonResponse(200, { volume: 10, kind: 'P9', kinds: [{ id: 'plan', label: '计划' }, { id: 7 }, null, 'x'] }),
  ])
  const state = await createTransport({ fetchImpl: impl }).getState()
  // `persistent` is the only authority for "can this environment store the value":
  // an unrecognised tier is diagnostics, not "cannot persist" (ADR §9.6/§9.8 expect
  // further tiers to appear, and the old whitelist would have reported them as none).
  assert.equal(state.kind, 'P9')
  assert.deepEqual(state.kinds, [{ id: 'plan', label: '计划' }])
})

test('setVolume: 200 round trip posts JSON and returns the settled value', async () => {
  const { impl, calls } = recordingFetch([jsonResponse(200, { volume: 30 })])
  const settled = await createTransport({ fetchImpl: impl }).setVolume(30)

  assert.equal(settled, 30)
  assert.equal(calls[0].url, '/perlica-ding/api/volume')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.body, JSON.stringify({ volume: 30 }))
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
})

test('setVolume: the server may clamp, and its value is authoritative', async () => {
  const { impl, calls } = recordingFetch([jsonResponse(200, { volume: 100 })])
  const settled = await createTransport({ fetchImpl: impl }).setVolume(999)

  assert.equal(settled, 100)
  assert.equal(calls[0].init.body, JSON.stringify({ volume: 999 }))
})

test('preview: 200 round trip posts the kind and returns what played', async () => {
  const { impl, calls } = recordingFetch([jsonResponse(200, { played: 'fail' })])
  const played = await createTransport({ fetchImpl: impl }).preview('fail')

  assert.equal(played, 'fail')
  assert.equal(calls[0].url, '/perlica-ding/api/preview')
  assert.equal(calls[0].init.body, JSON.stringify({ kind: 'fail' }))
})

test('a custom base replaces the default', async () => {
  const { impl, calls } = recordingFetch([jsonResponse(200, { volume: 1 })])
  await createTransport({ base: '/custom/api', fetchImpl: impl }).getState()
  assert.equal(calls[0].url, '/custom/api/state')
})

test('non-JSON body means the plugin route is missing', async () => {
  const { impl } = recordingFetch([jsonResponse(200, '<!doctype html>', 'text/html')])
  const error = await createTransport({ fetchImpl: impl }).getState().then(
    () => null,
    (caught) => caught,
  )

  assert.equal(error.code, 'route-missing')
  assert.equal(error.status, 200)
  assert.equal(error.message, ROUTE_MISSING_HEAD + '（HTTP 200）' + ROUTE_MISSING_TAIL)
  assert.ok(error.message.startsWith('插件后台接口未就绪'))
  assert.ok(error.message.includes('请重启 DSH 后重试'))
})

test('a POST answered by the SPA handler is also route-missing', async () => {
  const { impl } = recordingFetch([jsonResponse(405, '', 'text/plain')])
  const error = await createTransport({ fetchImpl: impl }).setVolume(50).then(
    () => null,
    (caught) => caught,
  )

  assert.equal(error.code, 'route-missing')
  assert.equal(error.status, 405)
})

test('an unreachable host is route-missing, with no status', async () => {
  const { impl } = recordingFetch([new TypeError('Failed to fetch')])
  const error = await createTransport({ fetchImpl: impl }).getState().then(
    () => null,
    (caught) => caught,
  )

  assert.equal(error.code, 'route-missing')
  assert.equal(error.status, undefined)
  assert.equal(error.message, ROUTE_MISSING_HEAD + ROUTE_MISSING_TAIL)
})

test('403 surfaces as http with the status and the server error field', async () => {
  const { impl } = recordingFetch([jsonResponse(403, { error: 'forbidden origin' })])
  const error = await createTransport({ fetchImpl: impl }).setVolume(10).then(
    () => null,
    (caught) => caught,
  )

  assert.equal(error.code, 'http')
  assert.equal(error.status, 403)
  assert.equal(error.message, 'forbidden origin')
})

test('500 surfaces as http with the status even without an error field', async () => {
  const { impl } = recordingFetch([jsonResponse(500, {})])
  const error = await createTransport({ fetchImpl: impl }).preview('done').then(
    () => null,
    (caught) => caught,
  )

  assert.equal(error.code, 'http')
  assert.equal(error.status, 500)
  assert.equal(error.message, 'HTTP 500')
})

test('413 body-too-large surfaces as http 413', async () => {
  const { impl } = recordingFetch([jsonResponse(413, { error: 'request body too large' })])
  const error = await createTransport({ fetchImpl: impl }).setVolume(80).then(
    () => null,
    (caught) => caught,
  )

  assert.equal(error.code, 'http')
  assert.equal(error.status, 413)
  assert.equal(error.message, 'request body too large')
})

test('a state without a volume field is bad-payload', async () => {
  const { impl } = recordingFetch([jsonResponse(200, { enabled: true })])
  const error = await createTransport({ fetchImpl: impl }).getState().then(
    () => null,
    (caught) => caught,
  )

  assert.equal(error.code, 'bad-payload')
})

test('a non-numeric volume is bad-payload', async () => {
  for (const bad of ['60', null, undefined, Number.NaN]) {
    const { impl } = recordingFetch([jsonResponse(200, { volume: bad })])
    const error = await createTransport({ fetchImpl: impl }).getState().then(
      () => null,
      (caught) => caught,
    )
    assert.equal(error.code, 'bad-payload', 'volume ' + String(bad))
  }
})

test('an out-of-range volume is rejected rather than silently accepted', async () => {
  const { impl } = recordingFetch([jsonResponse(200, { volume: 150 })])
  const error = await createTransport({ fetchImpl: impl }).getState().then(
    () => null,
    (caught) => caught,
  )
  assert.equal(error.code, 'bad-payload')
})

test('a volume response with no volume field is bad-payload', async () => {
  const { impl } = recordingFetch([jsonResponse(200, { ok: true })])
  const error = await createTransport({ fetchImpl: impl }).setVolume(20).then(
    () => null,
    (caught) => caught,
  )
  assert.equal(error.code, 'bad-payload')
})

test('a preview response without a played field is bad-payload', async () => {
  const { impl } = recordingFetch([jsonResponse(200, {})])
  const error = await createTransport({ fetchImpl: impl }).preview('ask').then(
    () => null,
    (caught) => caught,
  )
  assert.equal(error.code, 'bad-payload')
})

test('malformed JSON on a 200 is bad-payload, not route-missing', async () => {
  const { impl } = recordingFetch([
    {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    },
  ])
  const error = await createTransport({ fetchImpl: impl }).getState().then(
    () => null,
    (caught) => caught,
  )

  assert.equal(error.code, 'bad-payload')
})

test('setVolume rejects a non-numeric argument before any request', async () => {
  const { impl, calls } = recordingFetch([])
  const error = await createTransport({ fetchImpl: impl }).setVolume('60').then(
    () => null,
    (caught) => caught,
  )

  assert.equal(error.code, 'bad-payload')
  assert.equal(calls.length, 0)
})

test('createTransport falls back to the ambient fetch, and refuses to build without one', () => {
  // Ambient fetch present: no explicit fetchImpl still yields a working transport.
  assert.doesNotThrow(() => createTransport({ base: '/x' }))

  // Ambient fetch absent: the module reports it instead of failing at call time.
  const saved = globalThis.fetch
  let removable = false
  try {
    delete globalThis.fetch
    removable = typeof globalThis.fetch === 'undefined'
    if (removable) {
      assert.throws(() => createTransport({ base: '/x' }), (error) => error.code === 'bad-payload')
    }
  } finally {
    if (removable || typeof globalThis.fetch === 'undefined') globalThis.fetch = saved
  }
})

test('the transport never retries: one failure is one request', async () => {
  const { impl, calls } = recordingFetch([jsonResponse(500, { error: 'boom' })])
  await createTransport({ fetchImpl: impl }).getState().catch(() => null)
  assert.equal(calls.length, 1)
})
