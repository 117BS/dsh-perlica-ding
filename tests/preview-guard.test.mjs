// The settings page must never report a playback that did not happen. The master
// switch lives in the plugin config, so a disabled plugin refuses a preview instead
// of answering `played` and leaving the user with silence (review finding ①-3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'perlica-preview-'))

const { activateHost } = await import('../lib/host/activate.mjs')

const spawned = []
let route = null

function context() {
  const listeners = new Map()
  return {
    logger: () => ({ warn() {}, error() {}, info() {} }),
    get: (name) => (name === 'subprocess'
      ? { spawn: (spec) => { spawned.push(spec.argv); return { done: Promise.resolve({ code: 0 }) } } }
      : undefined),
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    inject: (_deps, callback) => callback({ effect: (factory) => void factory(), webServer: { register: (r) => { route = r; return () => { route = null } } } }),
    effect: (factory) => factory(),
    listeners,
  }
}

function post(path, body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = path
  req.headers = { 'content-type': 'application/json' }
  const response = { status: 0, body: '' }
  const res = { writeHead: (s) => { response.status = s }, end: (p) => { response.body = p ?? '' } }
  const done = new Promise((resolve) => {
    const original = res.end
    res.end = (p) => { original(p); resolve(response) }
  })
  route.handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  return done
}

test('a disabled plugin refuses a preview instead of claiming it played', async () => {
  spawned.length = 0
  const dispose = await activateHost(context(), { enabled: false, debounceMs: 2500, soundDir: '', volume: 100, execTools: [] }, { channel: 'native' })
  const refusal = await post('/perlica-ding/api/preview', { kind: 'done' })
  assert.equal(refusal.status, 409)
  assert.match(JSON.parse(refusal.body).error, /disabled/)
  assert.equal(spawned.length, 0, 'nothing may be played when the master switch is off')
  await dispose()
})

test('an enabled plugin still previews', async () => {
  spawned.length = 0
  const dispose = await activateHost(context(), { enabled: true, debounceMs: 2500, soundDir: '', volume: 100, execTools: [] }, { channel: 'native' })
  const played = await post('/perlica-ding/api/preview', { kind: 'done' })
  assert.equal(played.status, 200)
  assert.equal(JSON.parse(played.body).played, 'done')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(spawned.length > 0, 'the enabled path must reach the player')
  await dispose()
})
