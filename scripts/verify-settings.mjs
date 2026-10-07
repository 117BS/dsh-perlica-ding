/**
 * Settings-page bridge verification for dsh-perlica-ding.
 * Drives the host half's HTTP route with a fake req/res pair and asserts the
 * state / volume / preview endpoints behave, including the settings-backed
 * persistence path.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply } from '../index.mjs'

let failed = 0
function assert(cond, label) {
  if (cond) console.log(`  PASS ${label}`)
  else { console.error(`  FAIL ${label}`); failed++ }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-perlica-api-'))
for (const kind of ['plan', 'done', 'ask', 'fail']) {
  writeFileSync(join(dir, kind + '.wav'), 'placeholder')
}

/** Minimal fake of node:http req/res around a JSON body. */
function fakeReq(method, url, body, extraHeaders) {
  const listeners = {}
  const req = {
    method,
    url,
    headers: Object.assign(
      { host: '127.0.0.1:3080' },
      body !== undefined ? { 'content-type': 'application/json' } : null,
      extraHeaders || null,
    ),
    on(event, cb) {
      listeners[event] = cb
      return req
    },
    _fire() {
      if (body !== undefined && listeners.data) listeners.data(JSON.stringify(body))
      if (listeners.end) listeners.end()
    },
  }
  return req
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
      return res
    },
    end(chunk) {
      res.body = chunk || ''
      return res
    },
  }
  return res
}

/** Build a ctx whose settings service records writes. */
function makeCtx(initialVolume) {
  const handlers = {}
  let volume = initialVolume
  let settingsRegistered = null
  const spawns = []
  const ctx = {
    get(service) {
      if (service === 'subprocess') {
        return {
          spawn(spec) {
            spawns.push(spec.argv)
            return { done: new Promise(() => {}) }
          },
        }
      }
      if (service === 'agents') return { roots: () => [{ id: 'root' }] }
      if (service === 'settings') {
        return {
          register(ns, schema, options) {
            settingsRegistered = { ns, options, schema }
            return {
              get: () => ({ volume }),
              update: async (patch) => {
                if (typeof patch.volume === 'number') volume = patch.volume
              },
              watch: () => () => {},
            }
          },
        }
      }
      if (service === 'webServer') {
        return {
          register(route) {
            ctx._route = route
            return () => {}
          },
        }
      }
      return undefined
    },
    on(event, listener) { handlers[event] = listener },
    effect(fn) { return fn() },
    _route: null,
    _handlers: handlers,
    _spawns: spawns,
    _volume: () => volume,
    _settings: () => settingsRegistered,
  }
  return ctx
}

async function call(ctx, method, url, body, headers) {
  const req = fakeReq(method, url, body, headers)
  const res = fakeRes()
  const promise = ctx._route.handler(req, res)
  req._fire()
  await promise
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (error) { parsed = null }
  return { status: res.statusCode, body: parsed }
}

console.log('settings bridge:')

const ctx = makeCtx(100)
apply(ctx, Config({ soundDir: dir, debounceMs: 100, volume: 80 }))

assert(ctx._route !== null, 'HTTP route registered for the settings page')
assert(ctx._settings() !== null, 'settings namespace registered')
assert(ctx._settings().ns === 'dsh-perlica-ding', `namespace is dsh-perlica-ding (got ${ctx._settings() && ctx._settings().ns})`)
assert(ctx._settings().options.base.volume === 80, 'config volume becomes the settings base layer')

const state = await call(ctx, 'GET', '/perlica-ding/api/state')
assert(state.status === 200, 'GET /state returns 200')
assert(state.body.volume === 100, `state reports the settings volume first (got ${state.body && state.body.volume})`)
assert(Array.isArray(state.body.kinds) && state.body.kinds.length === 4, 'state lists four sound kinds')
assert(state.body.kinds.map((k) => k.id).join(',') === 'plan,done,ask,fail', 'kind ids are plan/done/ask/fail')
assert(state.body.kinds.every((k) => typeof k.label === 'string' && k.label.length > 0), 'every kind carries a label')

const setVol = await call(ctx, 'POST', '/perlica-ding/api/volume', { volume: 35 })
assert(setVol.status === 200, 'POST /volume returns 200')
assert(ctx._volume() === 35, `volume persisted through settings (got ${ctx._volume()})`)
assert(setVol.body.volume === 35, 'response echoes the stored volume')

const bad = await call(ctx, 'POST', '/perlica-ding/api/volume', { volume: 500 })
assert(bad.status === 400, 'out-of-range volume rejected with 400')

const badType = await call(ctx, 'POST', '/perlica-ding/api/volume', { volume: 'loud' })
assert(badType.status === 400, 'non-numeric volume rejected with 400')

const before = ctx._spawns.length
const preview = await call(ctx, 'POST', '/perlica-ding/api/preview', { kind: 'done' })
assert(preview.status === 200, 'POST /preview returns 200')
assert(ctx._spawns.length > before, 'preview actually spawned a playback process')
assert(preview.body.played === 'done', 'preview reports the played kind')

// preview ignores debounce: two immediate calls both play
const before2 = ctx._spawns.length
await call(ctx, 'POST', '/perlica-ding/api/preview', { kind: 'ask' })
await call(ctx, 'POST', '/perlica-ding/api/preview', { kind: 'ask' })
assert(ctx._spawns.length > before2 + 1, 'preview bypasses the debounce window')

const unknown = await call(ctx, 'POST', '/perlica-ding/api/preview', { kind: 'nope' })
assert(unknown.status === 400, 'unknown kind rejected with 400')

const missing = await call(ctx, 'GET', '/perlica-ding/api/nope')
assert(missing.status === 404, 'unknown route returns 404')

// --- admission rules -------------------------------------------------------
const crossOrigin = await call(ctx, 'GET', '/perlica-ding/api/state', undefined, { origin: 'https://evil.example' })
assert(crossOrigin.status === 403, 'cross-origin request refused with 403')

const sameOrigin = await call(ctx, 'GET', '/perlica-ding/api/state', undefined, { origin: 'http://127.0.0.1:3080' })
assert(sameOrigin.status === 200, 'same-origin request admitted')

const wrongType = await call(ctx, 'POST', '/perlica-ding/api/volume', { volume: 40 }, { 'content-type': 'text/plain' })
assert(wrongType.status === 415, 'non-JSON content type refused with 415')

// --- persistence tiers -----------------------------------------------------
// A host whose settings service has no `register` (the DSH 0.2 shape) must
// fall back to the plugin-owned file instead of losing the value.
const storeDir = mkdtempSync(join(tmpdir(), 'dsh-perlica-store-'))
process.env.DSH_PERLICA_DING_STORE = storeDir
const ctxFile = makeCtx(100)
const origGetFile = ctxFile.get
ctxFile.get = (service) => {
  if (service === 'settings') {
    // SettingsForms-like object: present, but without register.
    return { get: () => undefined, describe: () => [] }
  }
  return origGetFile(service)
}
apply(ctxFile, Config({ soundDir: dir, debounceMs: 100, volume: 100 }))

const fileState = await call(ctxFile, 'GET', '/perlica-ding/api/state')
assert(fileState.status === 200, 'state reachable on a register-less settings host')
assert(fileState.body.persistent === true, 'register-less host reports persistent (file tier)')

const fileWrite = await call(ctxFile, 'POST', '/perlica-ding/api/volume', { volume: 45 })
assert(fileWrite.status === 200, 'volume write accepted on the file tier')
const storePath = join(storeDir, 'volume.json')
assert(existsSync(storePath), 'volume file created on disk')
const stored = JSON.parse(readFileSync(storePath, 'utf8'))
assert(stored.volume === 45, `file tier stored 45 (got ${stored && stored.volume})`)
assert(fileWrite.body.volume === 45, 'file tier response echoes the stored volume')

// A *fresh* plugin instance reading the same directory must see the value:
// this is the restart path, exercised without a mock in between.
const ctxRestart = makeCtx(100)
const origGetRestart = ctxRestart.get
ctxRestart.get = (service) => (service === 'settings' ? { describe: () => [] } : origGetRestart(service))
apply(ctxRestart, Config({ soundDir: dir, debounceMs: 100, volume: 100 }))
const restarted = await call(ctxRestart, 'GET', '/perlica-ding/api/state')
assert(restarted.body.volume === 45, `volume survives a fresh instance (got ${restarted.body.volume})`)

// --- master switch guard ---------------------------------------------------
const ctxOff = makeCtx(100)
apply(ctxOff, Config({ soundDir: dir, debounceMs: 100, volume: 100, enabled: false }))
const offState = await call(ctxOff, 'GET', '/perlica-ding/api/state')
assert(offState.body.enabled === false, 'state reports the master switch as off')
const offPreview = await call(ctxOff, 'POST', '/perlica-ding/api/preview', { kind: 'done' })
assert(offPreview.status === 409, 'preview refused with 409 while disabled')
assert(ctxOff._spawns.length === 0, 'disabled preview spawns nothing')

// --- last: no settings service at all -> file tier, still isolated ---------
// Keep the redirect in place for this case too: an unisolated run would write
// into the developer's real ~/.dsh directory.
const storeDir2 = mkdtempSync(join(tmpdir(), 'dsh-perlica-store2-'))
process.env.DSH_PERLICA_DING_STORE = storeDir2
const ctx2 = makeCtx(100)
const origGet = ctx2.get
ctx2.get = (service) => (service === 'settings' ? undefined : origGet(service))
apply(ctx2, Config({ soundDir: dir, debounceMs: 100, volume: 100 }))
const captured = await call(ctx2, 'GET', '/perlica-ding/api/state')
assert(captured.body.persistent === true, 'without settings the file tier still persists')
const mem = await call(ctx2, 'POST', '/perlica-ding/api/volume', { volume: 20 })
assert(mem.status === 200 && mem.body.volume === 20, 'volume write accepted without settings')
assert(existsSync(join(storeDir2, 'volume.json')), 'no-settings fallback wrote to its own store dir')
delete process.env.DSH_PERLICA_DING_STORE

console.log(failed === 0 ? '\nALL BRIDGE TESTS PASSED' : `\n${failed} TEST(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
