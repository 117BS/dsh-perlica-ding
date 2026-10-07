/**
 * Host-level integration: the real `activateHost` driven over two generations of
 * harness API shape.
 *
 * ## What is real and what is faked
 *
 * Real: `activateHost`, the real playback engine, the real volume store, the
 * real HTTP route, the real decision core, and a real filesystem for both the
 * P2 document and the P3 state file (ADR §7.1 — a mocked persistence seam
 * proves nothing).
 *
 * Faked: only the harness *services* the ADR permits faking — `ctx`,
 * `subprocess`, `agents`, `planMode`, `webServer`, and the `storageDomain`
 * facility. The facility stand-in is backed by a real file on disk, so a value
 * written through P2 is genuinely on a medium and a second activation reads it
 * back.
 *
 * `@deepseek-ai/dsh-storage-domain` and `zod` are supplied through
 * `module.registerHooks` because this repository has no `node_modules`: the
 * plugin's P2 tier imports them dynamically at `open()` time, so without them
 * P2 could never be reached at all. The module-resolution hook is a test
 * harness facility, not a substitute for the seam under test.
 *
 * P1 is deliberately absent from every end-to-end case: neither entry point
 * passes `options.storageProviders`, so P1 exists only inside the store's
 * selection unit tests. See docs/workstreams/04-issue-closure.md.
 *
 * ## Scope caveat — API-shape simulation, not old-line evidence
 *
 * The 0.1.5-rc.2 case is an **API-shape simulation**. No real 0.1.5-line host is
 * observable on this machine, and T2 §9a records that gap: the 0.1.5 settings
 * service and the absence of `configEditor`/`profileContext` are reproduced
 * from the published 0.1.5-rc.2 type surfaces, not observed at runtime. The
 * 0.2.x case is likewise shape-simulated; only the desktop 0.2.0-rc.2 build is
 * actually running on this machine.
 *
 * Frozen contract: docs/adr/0001-persistence-seam.md §4.2/§6/§7, AC-3.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { activateHost, activationState } from '../lib/host/activate.mjs'

// --- the two host packages the repository cannot resolve ---------------------

/**
 * Faithful stand-ins for `@deepseek-ai/dsh-storage-domain` and `zod`.
 *
 * `defineDomain`/`domainTable`/`descriptorOf` reproduce the published
 * 0.2.0-rc.2 behaviour (including the `^[a-z][a-z0-9_]*$` name rule and the
 * `backup-and-skip` policy check); `z` implements only the surface the store's
 * spec uses. Kept in this file so the shim cannot silently drift into a
 * production path.
 */
const HOST_SHIM_SOURCE = `
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
export function domainTable(schema) { return { valueSchema: schema } }
export function defineDomain(spec) {
  if (!UNIT_NAME_RE.test(spec.name)) throw new Error('domain name ' + spec.name + ' must match ' + String(UNIT_NAME_RE))
  if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error('domain version must be a non-negative integer')
  if (spec.invalidRecords !== undefined && spec.invalidRecords !== 'backup-and-skip') throw new Error('invalidRecords must be backup-and-skip')
  for (const table of Object.keys(spec.tables)) if (!UNIT_NAME_RE.test(table)) throw new Error('table name ' + table + ' must match')
  return spec
}
export function descriptorOf(spec) {
  return { name: spec.name, version: spec.version, tables: Object.keys(spec.tables), hasGlobal: spec.global !== undefined }
}
function makeNumber(checks) {
  return {
    int() { return makeNumber(checks.concat([[function (v) { return Number.isInteger(v) }, 'must be an integer']])) },
    min(n) { return makeNumber(checks.concat([[function (v) { return typeof v === 'number' && v >= n }, 'must be >= ' + n]])) },
    max(n) { return makeNumber(checks.concat([[function (v) { return typeof v === 'number' && v <= n }, 'must be <= ' + n]])) },
    parse(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('expected a finite number')
      for (const pair of checks) if (!pair[0](value)) throw new TypeError(pair[1])
      return value
    },
  }
}
export const z = {
  number() { return makeNumber([]) },
  object(shape) {
    return {
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected an object')
        const out = {}
        for (const key of Object.keys(shape)) if (value[key] !== undefined) out[key] = shape[key].parse(value[key])
        return out
      },
    }
  },
}
`

const SHIM_URL = 'data:text/javascript,' + encodeURIComponent(HOST_SHIM_SOURCE)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-storage-domain' || specifier === 'zod') {
      return { url: SHIM_URL, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

// --- harness fakes -----------------------------------------------------------

/** A `storageDomain` facility stand-in backed by one real file per domain. */
function createFacility({ dir }) {
  const facility = { opens: 0 }
  facility.open = async (spec) => {
    facility.opens += 1
    const file = join(dir, spec.name + '.json')
    const tables = new Map()
    for (const name of Object.keys(spec.tables)) tables.set(name, new Map())
    try {
      const stored = JSON.parse(await readFile(file, 'utf8'))
      for (const table of Object.keys(stored.tables ?? {})) {
        for (const [key, value] of Object.entries(stored.tables[table] ?? {})) {
          try {
            // The durable read boundary validates every record, exactly as the
            // real facility does; `backup-and-skip` makes a bad row a miss.
            tables.get(table).set(key, spec.tables[table].valueSchema.parse(value))
          } catch {
            /* invalidRecords: 'backup-and-skip' */
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const persist = async () => {
      await mkdir(dir, { recursive: true })
      const out = {}
      for (const [name, rows] of tables) out[name] = Object.fromEntries(rows)
      await writeFile(file, JSON.stringify({ version: spec.version, tables: out }, null, 2), 'utf8')
    }
    return {
      name: spec.name,
      closed: false,
      table(name) {
        const rows = tables.get(name)
        if (rows === undefined) throw new Error('undeclared table ' + name)
        return {
          get: (key) => rows.get(key),
          put: async (key, value) => {
            rows.set(key, spec.tables[name].valueSchema.parse(value))
            await persist()
          },
        }
      },
      async close() {
        this.closed = true
      },
    }
  }
  return facility
}

/** A subprocess service whose spawn outcome the caller chooses. */
function createSubprocess({ outcome = 'ok' } = {}) {
  const service = { spawned: [] }
  service.spawn = (spec) => {
    service.spawned.push(spec)
    const done = outcome === 'reject'
      ? Promise.reject(new Error('player could not be launched'))
      : Promise.resolve({ exitCode: outcome === 'nonzero' ? 1 : 0 })
    return { done, kill() {} }
  }
  return service
}

/** A webServer service that records the routes it is handed. */
function createWebServer() {
  const service = { routes: [] }
  service.register = (route) => {
    service.routes.push(route)
    return () => {}
  }
  return service
}

/**
 * The `ctx` stand-in: service resolution, event fan-out, effect/inject capture.
 *
 * Any touch of `settings` — `ctx.settings` or `ctx.get('settings')` — is
 * recorded through `onSettingsTouch`, and the value handed back is supplied by
 * the caller. The plugin must never reach it.
 */
function createCtx({ services = {}, onSettingsTouch = () => {}, settingsValue = {} }) {
  const listeners = new Map()
  const base = {
    logger: () => ({ warn() {}, error() {}, info() {}, debug() {} }),
    get(name) {
      if (name === 'settings') {
        onSettingsTouch('ctx.get("settings")')
        return settingsValue
      }
      return services[name]
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => {}
    },
    effect(fn) {
      return fn()
    },
    inject(deps, callback) {
      if (Array.isArray(deps) && deps.includes('settings')) onSettingsTouch('ctx.inject(["settings"])')
      base.__injections.push({ deps, callback })
      return () => {}
    },
    __injections: [],
    __fire(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args)
    },
  }
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'settings') {
        onSettingsTouch('ctx.settings')
        return settingsValue
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/** An `http.IncomingMessage` stand-in that streams one body chunk. */
function createRequest({ method = 'GET', url = '/', headers = {}, body }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

/** An `http.ServerResponse` stand-in capturing status and payload. */
function createResponse() {
  const res = { status: null, body: null }
  res.writeHead = (status) => {
    res.status = status
  }
  res.end = (payload) => {
    res.body = payload
  }
  return res
}

/** Call one registered route and decode the JSON reply. */
async function callRoute(route, { method = 'GET', url, body } = {}) {
  const res = createResponse()
  const req = createRequest({
    method,
    url,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  })
  await route.handler(req, res)
  return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
}

// --- test scaffolding --------------------------------------------------------

const BASE_CONFIG = { enabled: true, volume: 90, debounceMs: 0, soundDir: '', execTools: ['pwsh'] }

const ROOT_AGENT = { id: 'root-1', session: { header: { cwd: 'C:\\Windows' }, events: [] } }

const cleanups = []

/**
 * Release everything one test activated, in reverse order.
 *
 * The plugin holds a process-wide activation token, so a leaked activation
 * would silently turn the NEXT activation into a no-op — cleanup is asserted
 * rather than assumed.
 */
async function runCleanups() {
  const pending = cleanups.splice(0).reverse()
  for (const cleanup of pending) await cleanup()
  assert.equal(activationState(), null, 'the activation token must be released before the next test')
}

/** Wrap a test body so its activations and temporary homes are always released. */
function withHost(body) {
  return async () => {
    try {
      await body()
    } finally {
      await runCleanups()
    }
  }
}

after(() => {
  assert.deepEqual(cleanups, [], 'no cleanup may outlive the file')
  assert.equal(activationState(), null, 'the activation token must be released at the end of the file')
})

/** A temporary harness home; the plugin never touches the user's real one. */
async function tempHome(label) {
  const root = await mkdtemp(join(tmpdir(), 'perlica-' + label + '-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/**
 * Activate the real host on a freshly built ctx.
 *
 * Returns `release()` so a test that needs a second activation can give the
 * process-wide token back; the same release also runs from the file's cleanup,
 * and is idempotent.
 */
async function activate({ label, home, config = BASE_CONFIG, services = {}, onSettingsTouch = () => {}, settingsValue = {} }) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  cleanups.push(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const ctx = createCtx({ services, onSettingsTouch, settingsValue })
  const dispose = await activateHost(ctx, { ...config }, { channel: 'native' })
  let released = false
  const release = async () => {
    if (released) return
    released = true
    await dispose()
  }
  cleanups.push(release)
  assert.equal(activationState(), 'native', label + ': the native channel must hold the activation token')
  const webServer = services.webServer
  assert.equal(webServer.routes.length, 1, label + ': exactly one route must be registered')
  return { ctx, route: webServer.routes[0], release }
}

/** The harness services every case needs, minus the persistence tier. */
function baseServices(extra = {}) {
  return {
    subprocess: createSubprocess(),
    agents: { roots: () => [ROOT_AGENT] },
    planMode: { get: () => ({ active: false }) },
    webServer: createWebServer(),
    settings: { update() {}, describe() {} },
    ...extra,
  }
}

/** Drive one full root turn that earns the `done` sound. */
function driveDoneTurn(ctx, agent) {
  ctx.__fire('agent/inbox/claimed', { agent })
  ctx.__fire('tools/result', { agent, name: 'pwsh' })
  ctx.__fire('agent/turn-stopping', { agent })
}

// --- the simulation ----------------------------------------------------------

describe('host API-shape simulation', () => {
  it('0.2.x API-shape simulation: a live storageDomain facility selects P2 and keeps the value across a re-activation', withHost(async () => {
    const home = await tempHome('sim-02')
    const domainDir = join(home, 'storages')
    const settingsCalls = []

    const settings = { update: () => settingsCalls.push('update'), describe: () => settingsCalls.push('describe') }
    const first = await activate({
      label: '0.2.x',
      home,
      services: baseServices({ storageDomain: createFacility({ dir: domainDir }), settings }),
    })

    assert.deepEqual(await callRoute(first.route, { url: '/perlica-ding/api/state' }), {
      status: 200,
      json: {
        volume: 90,
        enabled: true,
        debounceMs: 0,
        persistent: true,
        kind: 'P2',
        kinds: [
          { id: 'plan', label: '计划出方案' },
          { id: 'done', label: '任务完成' },
          { id: 'ask', label: '需要你回应' },
          { id: 'fail', label: '出错' },
        ],
      },
    }, 'a 0.2.x storageDomain must be selected as P2, and an empty tier must not shadow config.volume')

    const saved = await callRoute(first.route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 37 } })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.json, { volume: 37 })

    driveDoneTurn(first.ctx, ROOT_AGENT)
    assert.equal(first.ctx.__injections.length, 0, 'webServer resolved immediately, so no deferred injection')

    // The bytes are on the medium, not in the process.
    const onDisk = JSON.parse(await readFile(join(domainDir, 'perlica_ding.json'), 'utf8'))
    assert.equal(onDisk.tables.settings.volume.volume, 37)
    await first.release()

    // A fresh activation over the same store is the restart proxy.
    const second = await activate({
      label: '0.2.x reopen',
      home,
      services: baseServices({ storageDomain: createFacility({ dir: domainDir }), settings }),
    })
    const reread = await callRoute(second.route, { url: '/perlica-ding/api/state' })
    assert.equal(reread.json.volume, 37, 'the persisted volume must survive a fresh activation')
    assert.equal(reread.json.kind, 'P2')

    assert.deepEqual(settingsCalls, [], 'the settings seam must never be called, even when it looks usable')
  }))

  it('0.2.x API-shape simulation: without a storageDomain facility the same host falls to P3 on disk', withHost(async () => {
    const home = await tempHome('sim-p3')

    const { route } = await activate({ label: '0.2.x no facility', home, services: baseServices() })

    const state = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(state.json.kind, 'P3')
    assert.equal(state.json.persistent, true)
    assert.equal(state.json.volume, 90, 'the configured volume survives an empty fallback tier')

    await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 12 } })
    const onDisk = JSON.parse(await readFile(join(home, 'dsh-perlica-ding', 'state.json'), 'utf8'))
    assert.equal(onDisk.volume, 12, 'the fallback tier must land in the plugin state file')
  }))

  it('0.1.5-rc.2 API-shape simulation: a register-only settings seam with no configEditor/profileContext still assembles on P2', withHost(async () => {
    const home = await tempHome('sim-015')
    const domainDir = join(home, 'storages')
    const settingsCalls = []

    const { route } = await activate({
      label: '0.1.5-rc.2',
      home,
      services: baseServices({
        storageDomain: createFacility({ dir: domainDir }),
        // SettingsProvider has register and no update; configEditor and
        // profileContext are simply absent on this generation.
        settings: { register: () => settingsCalls.push('register') },
      }),
    })

    const state = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(state.json.kind, 'P2', 'the 0.1.5 shape reaches the same native tier')
    assert.equal(state.json.persistent, true)
    assert.equal(state.json.volume, 90, 'the configured volume survives an empty tier on this shape too')

    const saved = await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 5 } })
    assert.equal(saved.status, 200)
    assert.equal(JSON.parse(await readFile(join(domainDir, 'perlica_ding.json'), 'utf8')).tables.settings.volume.volume, 5)

    assert.deepEqual(settingsCalls, [], 'register must never be called, even when the shape offers it')
  }))

  it('0.1.5-rc.2 API-shape simulation: no storageDomain either, so the 0.1.5 shape degrades to P3 without crashing', withHost(async () => {
    const home = await tempHome('sim-015-p3')

    const { route } = await activate({
      label: '0.1.5-rc.2 degraded',
      home,
      services: baseServices({ settings: { register() {} } }),
    })

    const state = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(state.json.kind, 'P3')
    assert.equal(state.json.volume, 90)
    await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 44 } })
    assert.equal(JSON.parse(await readFile(join(home, 'dsh-perlica-ding', 'state.json'), 'utf8')).volume, 44)
  }))

  it('defect D1 regression: an empty tier must not shadow config.volume', withHost(async () => {
    const home = await tempHome('sim-d1')
    const domainDir = join(home, 'storages')
    const config = { ...BASE_CONFIG, volume: 30 }

    // A selectable but empty P2: the configured value must be what the page sees.
    const onP2 = await activate({
      label: 'D1/P2 empty',
      home,
      config,
      services: baseServices({ storageDomain: createFacility({ dir: domainDir }) }),
    })
    const emptyP2 = await callRoute(onP2.route, { url: '/perlica-ding/api/state' })
    assert.equal(emptyP2.json.kind, 'P2', 'capabilities still reports the selected tier')
    assert.equal(emptyP2.json.persistent, true)
    assert.equal(emptyP2.json.volume, 30, 'an empty P2 must fall back to config.volume, not to the model default')
    await callRoute(onP2.route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 70 } })
    await onP2.release()

    // Once a value is stored, the stored value beats the configured one.
    const onP2Stored = await activate({
      label: 'D1/P2 stored',
      home,
      config,
      services: baseServices({ storageDomain: createFacility({ dir: domainDir }) }),
    })
    const storedP2 = await callRoute(onP2Stored.route, { url: '/perlica-ding/api/state' })
    assert.equal(storedP2.json.volume, 70, 'a stored value must win over config.volume')
    assert.equal(storedP2.json.kind, 'P2')
    await onP2Stored.release()

    // A selectable but empty P3 behaves the same way.
    const onP3 = await activate({ label: 'D1/P3 empty', home, config, services: baseServices() })
    const emptyP3 = await callRoute(onP3.route, { url: '/perlica-ding/api/state' })
    assert.equal(emptyP3.json.kind, 'P3')
    assert.equal(emptyP3.json.volume, 30, 'an empty P3 must fall back to config.volume too')
  }))

  it('trap: a settings seam that explodes on any touch is never touched during a full turn', withHost(async () => {
    const home = await tempHome('sim-trap')
    const touches = []
    let armed = true

    const exploding = new Proxy({}, {
      get(_target, prop) {
        if (armed) throw new Error('ctx.settings must never be reached (property ' + String(prop) + ')')
        return undefined
      },
      has() {
        throw new Error('ctx.settings must never be probed')
      },
    })

    // Falsifiability self-check: the trap must actually explode, otherwise
    // "zero touches" would be evidence of nothing.
    assert.throws(() => exploding.register, /must never be reached/, 'the trap must be armed')
    armed = false
    assert.equal(exploding.register, undefined)
    armed = true

    const subprocess = createSubprocess()
    const { ctx, route } = await activate({
      label: 'trap',
      home,
      onSettingsTouch: (where) => touches.push(where),
      settingsValue: exploding,
      services: baseServices({ subprocess }),
    })

    // A full assembly, one settings write, and one whole turn.
    assert.equal((await callRoute(route, { url: '/perlica-ding/api/state' })).status, 200)
    assert.equal((await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 8 } })).status, 200)
    driveDoneTurn(ctx, ROOT_AGENT)
    assert.equal((await callRoute(route, { method: 'POST', url: '/perlica-ding/api/preview', body: { kind: 'done' } })).status, 200)

    assert.equal(subprocess.spawned.length >= 1, true, 'the turn must actually have played something')
    assert.deepEqual(touches, [], 'ctx.settings must never be accessed, directly or through ctx.get')
  }))
})
