/**
 * Unit tests for the playback engine.
 *
 * The engine owns the rate limit (BC4) and the platform argv chains (BC11);
 * these tests drive it through injected seams only, so they assert on the exact
 * argv the real adapter would spawn and never touch `process.platform`,
 * a real audio device, or the harness (T3 N19).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_DEBOUNCE_MS,
  PLAYER_GRACE_MS,
  createEngine,
  createSoundResolver,
  encodePowerShellCommand,
  playbackAttempts,
} from '../lib/host/engine.mjs'
import { DEFAULT_EXEC_TOOLS } from '../lib/core/exec-tools.mjs'
import { createDecider } from '../lib/core/scenarios.mjs'

/** Spawn stub that records every attempt and replays scripted outcomes. */
function recordingSpawn(outcomes = []) {
  const calls = []
  const spawn = (argv, options) => {
    const index = calls.length
    calls.push({ argv, options })
    const scripted = outcomes[index]
    if (scripted === 'throw') throw new Error('spawn failed')
    if (scripted === 'reject') return { done: Promise.reject(new Error('provider failed')) }
    if (scripted === undefined) return { done: Promise.resolve({ exitCode: 0, signal: null }) }
    return { done: Promise.resolve(scripted) }
  }
  return { calls, spawn }
}

/** Resolver over a fixed kind -> path map. */
const fixedResolver = (map) => (kind) => map[kind] ?? null

test('playbackAttempts encodes the Windows chain in order with a stable grace path', () => {
  const attempts = playbackAttempts('win32', "C:\\a\\it's.wav")
  assert.equal(attempts.length, 2)
  assert.ok(attempts[0].argv[0].endsWith('powershell.exe'))
  assert.equal(attempts[1].argv[0], 'pwsh.exe')
  assert.equal(attempts[0].cwd, 'C:\\Windows')
  assert.deepEqual(attempts[0].argv.slice(1, 4), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])

  const script = Buffer.from(attempts[1].argv[4], 'base64').toString('utf16le')
  assert.equal(script, "$p = New-Object Media.SoundPlayer 'C:\\a\\it''s.wav'; $p.PlaySync()")
})

test('playbackAttempts keeps the non-Windows chains', () => {
  assert.deepEqual(playbackAttempts('darwin', '/tmp/x.wav'), [{ argv: ['/usr/bin/afplay', '/tmp/x.wav'], cwd: '/' }])
  assert.deepEqual(playbackAttempts('linux', '/tmp/x.wav'), [
    { argv: ['paplay', '/tmp/x.wav'], cwd: '/' },
    { argv: ['aplay', '/tmp/x.wav'], cwd: '/' },
  ])
})

test('encodePowerShellCommand round-trips non-ASCII through UTF-16LE', () => {
  const text = "Play '佩丽卡.wav'"
  assert.equal(Buffer.from(encodePowerShellCommand(text), 'base64').toString('utf16le'), text)
})

test('the sound resolver searches candidates in order and returns null when none exist (K3, N13)', () => {
  const present = new Set(['/sounddir/done.wav', '/bundle/done.wav'])
  const resolve = createSoundResolver({
    candidates: ['/workspace', '/sounddir', '/bundle', '/os'],
    exists: (path) => present.has(path),
    join: (dir, name) => `${dir}/${name}`,
  })
  assert.equal(resolve('done'), '/sounddir/done.wav')

  const missing = createSoundResolver({
    candidates: ['/nowhere', '/elsewhere'],
    exists: () => false,
    join: (dir, name) => `${dir}/${name}`,
  })
  assert.equal(missing('done'), null, 'an all-miss lookup must be null, not a synthesized path')
})

test('the sound resolver tolerates an unreadable candidate and empty options', () => {
  const resolve = createSoundResolver({
    candidates: [undefined, '', '/boom', '/ok'],
    exists: (path) => {
      if (path.startsWith('/boom')) throw new Error('EACCES')
      return path === '/ok/plan.wav'
    },
    join: (dir, name) => `${dir}/${name}`,
  })
  assert.equal(resolve('plan'), '/ok/plan.wav')
  const empty = createSoundResolver({})
  assert.equal(empty('plan'), null, 'a resolver with no candidates resolves nothing')
  assert.equal(createSoundResolver().toString().length > 0, true)
})

test('createEngine refuses to build without its seams', () => {
  assert.throws(() => createEngine({ spawn: () => ({}) }), TypeError)
  assert.throws(() => createEngine({ resolveSound: () => null }), TypeError)
})

test('explicit debounceMs: same kind is held back, force bypasses it (BC4)', async () => {
  let clock = 5_000
  const { calls, spawn } = recordingSpawn()
  const engine = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    currentVolume: () => 100,
    now: () => clock,
    scaleFrameScaling: (path) => path,
  })

  const first = engine.play('done')
  assert.equal(first.played, true)
  await first.settled

  clock += 100
  const held = engine.play('done')
  assert.deepEqual({ played: held.played, reason: held.reason }, { played: false, reason: 'debounced' })
  assert.equal(calls.length, 1, 'a debounced play spawns nothing')

  const forced = engine.play('done', { force: true })
  assert.equal(forced.played, true, 'preview is never debounced')
  await forced.settled
  assert.equal(calls.length, 2)

  clock += DEFAULT_DEBOUNCE_MS + 1
  const later = engine.play('done')
  assert.equal(later.played, true)
  await later.settled
})

test('each kind keeps its own window (BC4)', async () => {
  let clock = 0
  const { spawn } = recordingSpawn()
  const engine = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ plan: '/s/plan.wav', done: '/s/done.wav', ask: '/s/ask.wav' }),
    spawn,
    debounceMs: 2_500,
    currentVolume: () => 100,
    now: () => clock,
    scaleFrameScaling: (path) => path,
  })
  assert.equal(engine.play('plan').played, true)
  assert.equal(engine.play('done').played, true)
  assert.equal(engine.play('ask').played, true)
  assert.equal(engine.play('plan').reason, 'debounced')
})

test('the default wiring imposes no engine window of its own', () => {
  const { spawn } = recordingSpawn()
  const engine = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn,
    currentVolume: () => 100,
    scaleFrameScaling: (path) => path,
  })
  assert.equal(engine.play('done').played, true)
  assert.equal(engine.play('done').played, true, 'with debounceMs omitted the engine does not gate')
})

test('unknown kinds and missing sounds are reported, not thrown (N13)', () => {
  const { calls, spawn } = recordingSpawn()
  const engine = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({}),
    spawn,
    currentVolume: () => 100,
    scaleFrameScaling: (path) => path,
  })
  assert.deepEqual(engine.play('nope'), { played: false, reason: 'unknown-kind', kind: 'nope' })
  assert.deepEqual(engine.play('done'), { played: false, reason: 'no-sound', kind: 'done', volume: 100 })
  assert.equal(engine.resolveSound('done'), null)
  assert.equal(calls.length, 0)
})

test('volume 0 mutes before any spawn, and a corrupt volume falls back to default (BC7)', () => {
  const { calls, spawn } = recordingSpawn()
  const volumes = { current: 0 }
  const engine = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn,
    currentVolume: () => volumes.current,
    scaleFrameScaling: (path) => path,
  })
  assert.equal(engine.play('done').reason, 'muted')
  assert.equal(calls.length, 0)

  volumes.current = 'loud'
  const repaired = engine.play('done')
  assert.equal(repaired.volume, 100)
  assert.equal(repaired.played, true)

  const throwing = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn,
    currentVolume: () => { throw new Error('store offline') },
    scaleFrameScaling: (path) => path,
  })
  assert.equal(throwing.play('done').volume, 100)
})

test('the engine scales through its injected scaler and plays the scaled path', () => {
  const { calls, spawn } = recordingSpawn()
  const seen = []
  const engine = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn,
    currentVolume: () => 50,
    scaleFrameScaling: (path, volume) => {
      seen.push([path, volume])
      return '/cache/scaled.wav'
    },
  })
  const outcome = engine.play('done')
  assert.deepEqual(seen, [['/s/done.wav', 50]])
  assert.equal(outcome.file, '/cache/scaled.wav')
  assert.equal(outcome.source, '/s/done.wav')
  assert.deepEqual(calls[0].argv, ['paplay', '/cache/scaled.wav'])
  assert.equal(calls[0].options.graceMs, PLAYER_GRACE_MS)
})

test('a failing scaler falls back to the original file instead of breaking playback', () => {
  const { calls, spawn } = recordingSpawn()
  const engine = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn,
    currentVolume: () => 30,
    scaleFrameScaling: () => { throw new Error('EACCES') },
  })
  const outcome = engine.play('done')
  assert.equal(outcome.played, true)
  assert.equal(outcome.file, '/s/done.wav')
  assert.deepEqual(calls[0].argv, ['paplay', '/s/done.wav'])
})

test('a non-zero exit escalates to the next interpreter (N7)', async () => {
  const { calls, spawn } = recordingSpawn([
    { exitCode: 1, signal: null },
    { exitCode: 0, signal: null },
  ])
  const engine = createEngine({
    platform: 'win32',
    resolveSound: fixedResolver({ ask: '/s/ask.wav' }),
    spawn,
    currentVolume: () => 100,
    scaleFrameScaling: (path) => path,
  })
  const outcome = engine.play('ask')
  assert.equal(outcome.played, true)
  assert.equal(await outcome.settled, true)
  assert.equal(calls.length, 2, 'the second interpreter is tried after a failed first exit')
  assert.ok(calls[0].argv[0].endsWith('powershell.exe'))
  assert.equal(calls[1].argv[0], 'pwsh.exe')
})

test('a provider rejection and a throwing spawn also escalate, and exhaustion reports false', async () => {
  const rejected = recordingSpawn(['reject', { exitCode: 0, signal: null }])
  const engineReject = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn: rejected.spawn,
    currentVolume: () => 100,
    scaleFrameScaling: (path) => path,
  })
  assert.equal(await engineReject.play('done').settled, true)
  assert.deepEqual(rejected.calls.map((c) => c.argv[0]), ['paplay', 'aplay'])

  const exhausted = recordingSpawn([{ exitCode: 3, signal: null }, { exitCode: 4, signal: null }])
  const engineDead = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn: exhausted.spawn,
    currentVolume: () => 100,
    scaleFrameScaling: (path) => path,
  })
  assert.equal(await engineDead.play('done').settled, false)
  assert.equal(exhausted.calls.length, 2)

  const throwing = recordingSpawn(['throw', 'throw'])
  const engineThrow = createEngine({
    platform: 'darwin',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn: throwing.spawn,
    currentVolume: () => 100,
    scaleFrameScaling: (path) => path,
  })
  assert.equal(await engineThrow.play('done').settled, false)
})

test('the engine never mutates the platform it was given (N19)', () => {
  const before = process.platform
  const descriptorBefore = Object.getOwnPropertyDescriptor(process, 'platform')
  const { spawn } = recordingSpawn()
  const engine = createEngine({
    platform: 'win32',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn,
    currentVolume: () => 100,
    scaleFrameScaling: (path) => path,
  })
  engine.play('done')
  assert.equal(process.platform, before)
  assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'platform'), descriptorBefore)
})

test('decider plus engine compose without narrowing the window (BC4, one policy owner)', () => {
  let clock = 1_000
  const { spawn } = recordingSpawn()
  const engine = createEngine({
    platform: 'linux',
    resolveSound: fixedResolver({ done: '/s/done.wav' }),
    spawn,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    currentVolume: () => 100,
    now: () => clock,
    scaleFrameScaling: (path) => path,
  })
  const decide = createDecider({
    isRoot: (id) => id === 'root',
    execTools: DEFAULT_EXEC_TOOLS,
    now: () => clock,
  })

  // Turn 1: real work, one sound.
  decide.claim('root')
  decide.toolResult('root', 'write')
  const first = decide.turnStopping('root', { planActive: false })
  assert.equal(first, 'done')
  assert.equal(engine.play(first).played, true)

  // Turn 2 immediately after: an honest new turn, still inside the window.
  decide.claim('root')
  decide.toolResult('root', 'write')
  const second = decide.turnStopping('root', { planActive: false })
  assert.equal(second, 'done')
  assert.deepEqual(engine.play(second).reason, 'debounced')

  // Past the window: audible again.
  clock += DEFAULT_DEBOUNCE_MS + 1
  decide.claim('root')
  decide.toolResult('root', 'write')
  assert.equal(engine.play(decide.turnStopping('root', { planActive: false })).played, true)
})
