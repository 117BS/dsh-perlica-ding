/**
 * Host-level negative paths: one case per row of the ADR §6 table, driven
 * through the real `activateHost` and the real HTTP route.
 *
 * ## What is real and what is faked
 *
 * Real: `activateHost`, the real store, the real route, and a real filesystem
 * for the P3 state file and its `.corrupt-*` preservation. Where a case needs a
 * medium failure (B3 below), the failure is produced by the filesystem itself —
 * the state directory is replaced by a regular file — not by a stub that
 * returns a rejection.
 *
 * Faked: only the harness services (ADR §7 allows `ctx`, `subprocess`,
 * `webServer`, and the `storageDomain` facility). The facility stand-in throws
 * on demand so the two `open()` failure rows can be exercised, and counts its
 * opens so "recorded once, never retried" is asserted rather than assumed.
 *
 * P1 is not wired in either entry point, so no case here reaches it; "three
 * tiers unavailable" means P2 absent and P3 unusable.
 *
 * Frozen contract: docs/adr/0001-persistence-seam.md §6.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { activateHost, activationState } from '../lib/host/activate.mjs'

// --- the two host packages the repository cannot resolve ---------------------

/** Same faithful stand-ins as tests/host-simulation.test.mjs; see that header. */
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

/**
 * A `storageDomain` facility that refuses to open, exactly as `code` says.
 *
 * `opens` is the ledger the "recorded once, never retried" row is asserted
 * against.
 */
function createRefusingFacility(code) {
  const facility = { opens: 0, code }
  facility.open = async () => {
    facility.opens += 1
    const error = new Error(code === 'already-open'
      ? "domain 'perlica_ding' is already open"
      : 'the storage medium is not writable')
    if (code !== null) error.code = code
    throw error
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
      : Promise.resolve({ exitCode: 0 })
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

/** The `ctx` stand-in: services, event fan-out, effect/inject capture. */
function createCtx({ services = {}, warnings = [] } = {}) {
  const listeners = new Map()
  const record = (level, message) => {
    if (level === 'warn' || level === 'error') warnings.push(String(message))
  }
  const base = {
    logger: () => ({
      warn: (message) => record('warn', message),
      error: (message) => record('error', message),
      info() {},
      debug() {},
    }),
    get: (name) => services[name],
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => {}
    },
    effect: (fn) => fn(),
    inject(deps, callback) {
      base.__injections.push({ deps, callback })
      return () => {}
    },
    __injections: [],
    __fire(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args)
    },
  }
  return base
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

/** Call one registered route and decode the JSON reply. */
async function callRoute(route, { method = 'GET', url, body, headers = {} } = {}) {
  const res = { status: null, body: null }
  res.writeHead = (status) => {
    res.status = status
  }
  res.end = (payload) => {
    res.body = payload
  }
  const req = createRequest({
    method,
    url,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  })
  await route.handler(req, res)
  return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
}

// --- test scaffolding --------------------------------------------------------

const BASE_CONFIG = { enabled: true, volume: 60, debounceMs: 0, soundDir: '', execTools: ['pwsh'] }

const ROOT_AGENT = { id: 'root-1', session: { header: { cwd: 'C:\\Windows' }, events: [] } }

const cleanups = []

async function runCleanups() {
  const pending = cleanups.splice(0).reverse()
  for (const cleanup of pending) await cleanup()
  assert.equal(activationState(), null, 'the activation token must be released before the next test')
}

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

async function tempHome(label) {
  const root = await mkdtemp(join(tmpdir(), 'perlica-' + label + '-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** Activate the real host and return the route, the ctx, and the warning log. */
async function activate({ label, home, services, config = BASE_CONFIG }) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  cleanups.push(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const warnings = []
  const ctx = createCtx({ services, warnings })
  const dispose = await activateHost(ctx, { ...config }, { channel: 'native' })
  cleanups.push(() => dispose())
  assert.equal(activationState(), 'native', label + ': the native channel must hold the activation token')
  assert.equal(services.webServer.routes.length, 1, label + ': exactly one route must be registered')
  return { ctx, warnings, route: services.webServer.routes[0] }
}

function baseServices(extra = {}) {
  return {
    subprocess: createSubprocess(),
    agents: { roots: () => [ROOT_AGENT] },
    planMode: { get: () => ({ active: false }) },
    webServer: createWebServer(),
    ...extra,
  }
}

const STATE_FILE = join('dsh-perlica-ding', 'state.json')

// --- ADR §6 rows -------------------------------------------------------------

describe('ADR §6 negative paths over the real host', () => {
  it('an already-open storageDomain degrades to P3 without crashing', withHost(async () => {
    const home = await tempHome('neg-already-open')
    const facility = createRefusingFacility('already-open')

    const { route } = await activate({ label: 'already-open', home, services: baseServices({ storageDomain: facility }) })

    const state = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(state.json.kind, 'P3', 'a domain that is already open must fall through to the file tier')
    assert.equal(state.json.persistent, true)

    const saved = await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 33 } })
    assert.equal(saved.status, 200, 'the fallback tier must still be writable')
    assert.equal(JSON.parse(await readFile(join(home, STATE_FILE), 'utf8')).volume, 33)
  }))

  it('any other storageDomain failure degrades once and is never retried', withHost(async () => {
    const home = await tempHome('neg-open-throws')
    const facility = createRefusingFacility(null)

    const { route } = await activate({ label: 'open throws', home, services: baseServices({ storageDomain: facility }) })

    assert.equal(facility.opens, 1, 'the failing tier is attempted exactly once at selection')
    await callRoute(route, { url: '/perlica-ding/api/state' })
    await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 21 } })
    await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(facility.opens, 1, 'later reads and writes must not re-walk the chain')

    const state = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(state.json.kind, 'P3')
  }))

  it('a failed write answers 5xx and the page never shows the submitted value', withHost(async () => {
    const home = await tempHome('neg-write')
    const { route } = await activate({ label: 'write fails', home, services: baseServices() })

    const before = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(before.json.kind, 'P3', 'P3 is selected and open before the medium breaks')

    // A genuine medium failure: the state directory becomes a regular file, so
    // the atomic temp write can no longer land.
    await rm(join(home, 'dsh-perlica-ding'), { recursive: true, force: true })
    await writeFile(join(home, 'dsh-perlica-ding'), 'not a directory', 'utf8')

    const failed = await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 99 } })
    assert.equal(failed.status >= 500 && failed.status < 600, true, 'a failed write must not answer 2xx, got ' + failed.status)
    assert.equal(typeof failed.json.error, 'string', 'the failure must carry a message for the page')

    const after = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(after.json.volume, before.json.volume, 'the in-memory value must not advance on a failed write')
    assert.notEqual(after.json.volume, 99, 'the page must never be told the submitted value was saved')
  }))

  it('a corrupt P3 document is quarantined and the host keeps reading and writing', withHost(async () => {
    const home = await tempHome('neg-corrupt')
    const stateDir = join(home, 'dsh-perlica-ding')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'state.json'), '{ not json at all', 'utf8')

    const { route } = await activate({ label: 'corrupt state', home, services: baseServices() })

    const quarantined = (await readdir(stateDir)).filter((name) => name.startsWith('state.json.corrupt-'))
    assert.equal(quarantined.length, 1, 'the damaged document must be preserved, not overwritten')
    assert.equal(await readFile(join(stateDir, quarantined[0]), 'utf8'), '{ not json at all', 'the original bytes survive')

    const state = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(state.json.kind, 'P3')
    assert.equal(state.json.volume, 60, 'a damaged document reads as no value, so config.volume applies')

    const saved = await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 25 } })
    assert.equal(saved.status, 200, 'the host must keep writing after a damaged document')
    assert.equal(JSON.parse(await readFile(join(home, STATE_FILE), 'utf8')).volume, 25)
  }))

  it('with every tier unusable the host reports none and still serves the configured volume', withHost(async () => {
    const home = await tempHome('neg-all-down')
    // DSH_HOME points at a regular file, so P3 cannot even create its directory.
    const blocked = join(home, 'blocked')
    await writeFile(blocked, 'not a directory', 'utf8')

    const { route } = await activate({ label: 'all tiers down', home: blocked, services: baseServices() })

    const state = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(state.json.kind, 'none')
    assert.equal(state.json.persistent, false)
    assert.equal(state.json.volume, 60, 'the configured volume is the last resort and must be served')

    const failed = await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 80 } })
    assert.equal(failed.status >= 500, true, 'a write with no tier must fail loudly, not silently succeed')
  }))

  it('a playback spawn failure neither crashes the host nor leaks an unhandled rejection', withHost(async () => {
    const home = await tempHome('neg-spawn')
    const rejections = []
    const onRejection = (reason) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    cleanups.push(() => process.removeListener('unhandledRejection', onRejection))

    const subprocess = createSubprocess({ outcome: 'reject' })
    const { ctx, route } = await activate({ label: 'spawn fails', home, services: baseServices({ subprocess }) })

    ctx.__fire('agent/inbox/claimed', { agent: ROOT_AGENT })
    ctx.__fire('tools/result', { agent: ROOT_AGENT, name: 'pwsh' })
    ctx.__fire('agent/turn-stopping', { agent: ROOT_AGENT })
    const preview = await callRoute(route, { method: 'POST', url: '/perlica-ding/api/preview', body: { kind: 'done' } })

    assert.equal(preview.status, 200, 'the route must still answer after a failed player spawn')
    assert.equal(subprocess.spawned.length >= 1, true, 'the host must actually have tried to play')

    // Let every rejection settle before counting.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(rejections, [], 'a spawn rejection must be handled, never left unhandled')

    const state = await callRoute(route, { url: '/perlica-ding/api/state' })
    assert.equal(state.status, 200, 'the host stays alive after a failed playback')
  }))

  it('a webServer that arrives after activation still gets the route registered', withHost(async () => {
    const home = await tempHome('neg-late-web')
    const services = {
      subprocess: createSubprocess(),
      agents: { roots: () => [ROOT_AGENT] },
      planMode: { get: () => ({ active: false }) },
      // No webServer at activation time.
    }
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    })
    const ctx = createCtx({ services })
    const dispose = await activateHost(ctx, { ...BASE_CONFIG }, { channel: 'native' })
    cleanups.push(() => dispose())

    // Two deferrals are expected: the store waits for storageDomain, and the
    // host waits for webServer. Take the one this case is about.
    const deferred = ctx.__injections.find((entry) => entry.deps.length === 1 && entry.deps[0] === 'webServer')
    assert.notEqual(deferred, undefined, 'the missing webServer must be deferred through ctx.inject')
    assert.deepEqual(deferred.deps, ['webServer'])

    const late = createWebServer()
    const scope = {
      webServer: late,
      effect: (fn) => fn(),
    }
    deferred.callback(scope)

    assert.equal(late.routes.length, 1, 'the deferred injection must register the settings route')
    const state = await callRoute(late.routes[0], { url: '/perlica-ding/api/state' })
    assert.equal(state.status, 200, 'the late-registered route must work')
    assert.equal(state.json.kind, 'P3')
  }))
})

describe('ADR §4.5 transport admission rules', () => {
  it('admits a missing Origin and the two legitimate browser origins, and refuses the rest', withHost(async () => {
    const home = await tempHome('adm-origin')
    const { route } = await activate({ label: 'origin rules', home, services: baseServices() })

    // The desktop renderer's forwarded request arrives with Origin deleted.
    assert.equal((await callRoute(route, { url: '/perlica-ding/api/state' })).status, 200, 'a missing Origin must be admitted')
    assert.equal((await callRoute(route, { url: '/perlica-ding/api/state', headers: {} })).status, 200)

    const desktop = await callRoute(route, { url: '/perlica-ding/api/state', headers: { origin: 'dsh-app://app' } })
    assert.equal(desktop.status, 200, 'the desktop document origin must be admitted')

    const loopback = await callRoute(route, { url: '/perlica-ding/api/state', headers: { origin: 'http://127.0.0.1:19387' } })
    assert.equal(loopback.status, 200, 'the loopback browser origin must be admitted')

    const foreign = await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 5 }, headers: { origin: 'https://evil.example' } })
    assert.equal(foreign.status, 403, 'a foreign origin must be refused before the handler runs')
  }))

  it('refuses a non-JSON content type, an oversized body, and an unknown path', withHost(async () => {
    const home = await tempHome('adm-body')
    const { route } = await activate({ label: 'body rules', home, services: baseServices() })

    // A cross-site "simple request" cannot set application/json, so this is the
    // content type a forged POST actually carries.
    const form = await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume', body: { volume: 5 }, headers: { 'content-type': 'text/plain' } })
    assert.equal(form.status, 415, 'a non-JSON content type must be refused')

    const oversized = JSON.stringify({ volume: 5, pad: 'x'.repeat(9000) })
    const res = { status: null, body: null }
    res.writeHead = (status) => {
      res.status = status
    }
    res.end = (payload) => {
      res.body = payload
    }
    const req = createRequest({ method: 'POST', url: '/perlica-ding/api/volume', body: oversized, headers: { 'content-type': 'application/json' } })
    await route.handler(req, res)
    assert.equal(res.status, 413, 'a body past the cap must be refused rather than truncated')

    assert.equal((await callRoute(route, { url: '/perlica-ding/api/elsewhere' })).status, 404, 'only the three operations may be reachable')
    assert.equal((await callRoute(route, { method: 'POST', url: '/perlica-ding/api/volume' })).status, 415, 'a POST with no content type is not JSON')
  }))
})
