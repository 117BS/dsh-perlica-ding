/**
 * Unit tests for the pure decision layer.
 *
 * These pin the documented contract, not the current implementation:
 * `docs/workstreams/03-plugin-audit.md` BC1-BC5 and
 * `docs/adr/0001-persistence-seam.md` §5.
 *
 * Everything here is deterministic: the clock is injected, the file system is
 * an in-memory map, and `process.platform` is never touched (T3 N19).
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { KINDS, KIND_LABELS } from '../lib/core/kinds.mjs'
import { VOLUME_PRESETS, DEFAULT_VOLUME, clampVolume, normalizeVolume } from '../lib/core/volume.mjs'
import { DEFAULT_EXEC_TOOLS, isExecutionTool } from '../lib/core/exec-tools.mjs'
import { DEFAULT_CACHE_DIR, cacheKeyFor, contentDigest, scaleWavVolume } from '../lib/core/wav.mjs'
import { createDecider } from '../lib/core/scenarios.mjs'

const ROOT = 'root-session'
const CHILD = 'child-session'
const CACHE_DIR = join(tmpdir(), 'perlica-test-cache')

/** Minimal 16-bit PCM mono WAV with the given samples. */
function pcmWav(samples, { sampleRate = 8000, bits = 16 } = {}) {
  const bytes = bits / 8
  const dataSize = samples.length * bytes
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * bytes, 28)
  buf.writeUInt16LE(bytes, 32)
  buf.writeUInt16LE(bits, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  samples.forEach((sample, i) => buf.writeInt16LE(sample, 44 + i * 2))
  return buf
}

/** Read 16-bit samples back out of a PCM WAV. */
function readSamples(buf) {
  const dataSize = buf.readUInt32LE(40)
  const out = []
  for (let i = 0; i + 1 < dataSize; i += 2) out.push(buf.readInt16LE(44 + i))
  return out
}

/** In-memory stand-in for the file seam used by `scaleWavVolume`. */
function memoryIo(files) {
  const store = new Map(Object.entries(files))
  const writes = []
  return {
    store,
    writes,
    io: {
      exists: (path) => store.has(path),
      readFile: (path) => {
        if (!store.has(path)) throw new Error(`ENOENT ${path}`)
        return store.get(path)
      },
      writeFile: (path, data) => { store.set(path, data); writes.push(path) },
      rename: (from, to) => {
        if (!store.has(from)) throw new Error(`ENOENT ${from}`)
        store.set(to, store.get(from))
        store.delete(from)
      },
      mkdir: () => {},
    },
  }
}

/** Decider with the audited defaults plus injected inputs. */
function decider(overrides = {}) {
  return createDecider({
    isRoot: (id) => id === ROOT,
    execTools: DEFAULT_EXEC_TOOLS,
    debounceMs: 0,
    now: () => 0,
    ...overrides,
  })
}

test('kinds stay in their documented order with their labels', () => {
  assert.deepEqual(KINDS, ['plan', 'done', 'ask', 'fail'])
  assert.deepEqual(KIND_LABELS, {
    plan: '计划出方案',
    done: '任务完成',
    ask: '需要你回应',
    fail: '出错',
  })
})

test('volume presets cover the documented ladder', () => {
  assert.deepEqual(VOLUME_PRESETS.map((p) => p.value), [100, 60, 30, 0])
})

test('normalizeVolume accepts range ends, rounds fractions, clamps out-of-range', () => {
  assert.equal(normalizeVolume(0), 0)
  assert.equal(normalizeVolume(100), 100)
  assert.equal(normalizeVolume(42.4), 42)
  assert.equal(normalizeVolume(42.5), 43)
  assert.equal(normalizeVolume(-5), 0)
  assert.equal(normalizeVolume(1000), 100)
})

test('normalizeVolume rejects non-finite and non-numeric input', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => normalizeVolume(bad), TypeError, `normalizeVolume(${bad})`)
  }
  for (const bad of [undefined, null, '60', true, {}, [], () => 1]) {
    assert.throws(() => normalizeVolume(bad), TypeError, `normalizeVolume(${JSON.stringify(bad)})`)
  }
})

test('clampVolume never throws and falls back to the default', () => {
  assert.equal(DEFAULT_VOLUME, 100)
  assert.equal(clampVolume(0), 0)
  assert.equal(clampVolume(100), 100)
  assert.equal(clampVolume(999), 100)
  assert.equal(clampVolume(-999), 0)
  for (const bad of [undefined, null, '60', true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(clampVolume(bad), DEFAULT_VOLUME, `clampVolume(${JSON.stringify(bad)})`)
  }
})

test('exec whitelist keeps legacy "empty means everything" semantics (BC3)', () => {
  assert.equal(isExecutionTool('write', DEFAULT_EXEC_TOOLS), true)
  assert.equal(isExecutionTool('read', DEFAULT_EXEC_TOOLS), false)
  assert.equal(isExecutionTool('write', []), true)
  assert.equal(isExecutionTool('anything_at_all', []), true)
  assert.equal(isExecutionTool('write', undefined), true)
  assert.equal(isExecutionTool('', DEFAULT_EXEC_TOOLS), false)
})

test('default exec whitelist counts effects and excludes pure reading/bookkeeping (N6)', () => {
  for (const name of ['pwsh', 'bash', 'write', 'edit', 'str_replace_editor', 'present',
    'subagent', 'subagent_fork', 'spawn_teammate', 'send_message', 'wait_agent',
    'team_task_create', 'team_task_update', 'workflow', 'cordis_run',
    'job_output', 'job_kill', 'create_goal', 'update_goal', 'terminal_open', 'terminal_signal']) {
    assert.equal(isExecutionTool(name, DEFAULT_EXEC_TOOLS), true, `${name} should count`)
  }
  for (const name of ['read', 'grep', 'glob', 'web_search', 'web_fetch', 'skill',
    'list_agents', 'job_list', 'cordis_inspect_list', 'cordis_inspect_query',
    'todo_write', 'get_goal', 'list_subagent_models', 'read_image']) {
    assert.equal(isExecutionTool(name, DEFAULT_EXEC_TOOLS), false, `${name} should not count`)
  }
})

test('pure conversation stays silent (BC2)', () => {
  const d = decider()
  d.claim(ROOT)
  assert.equal(d.turnStopping(ROOT, { planActive: false }), null)
})

test('a turn with only lookup tools stays silent (BC2)', () => {
  const d = decider()
  d.claim(ROOT)
  d.toolResult(ROOT, 'read')
  d.toolResult(ROOT, 'web_search')
  d.toolResult(ROOT, 'todo_write')
  assert.equal(d.turnStopping(ROOT, { planActive: false }), null)
})

test('a turn with an execution tool earns done (BC1)', () => {
  const d = decider()
  d.claim(ROOT)
  d.toolResult(ROOT, 'write')
  assert.equal(d.turnStopping(ROOT, { planActive: false }), 'done')
})

test('a claim resets the previous turn marker: no work leaks across turns (N3)', () => {
  const d = decider()
  d.claim(ROOT)
  d.toolResult(ROOT, 'pwsh')
  assert.equal(d.turnStopping(ROOT, { planActive: false }), 'done')
  d.claim(ROOT)
  assert.equal(d.turnStopping(ROOT, { planActive: false }), null)
})

test('an execution tool observed before the claim still counts for that turn', () => {
  const d = decider()
  d.toolResult(ROOT, 'pwsh')
  d.claim(ROOT)
  d.toolResult(ROOT, 'write')
  assert.equal(d.turnStopping(ROOT, { planActive: false }), 'done')
})

test('a plan-mode turn earns plan, and plan wins over done (BC1)', () => {
  const d = decider()
  d.claim(ROOT)
  d.toolResult(ROOT, 'write')
  assert.equal(d.turnStopping(ROOT, { planActive: true }), 'plan')
})

test('subagent turns never decide a sound, in either direction (BC5, K5)', () => {
  const d = decider()
  d.claim(CHILD)
  d.toolResult(CHILD, 'write')
  assert.equal(d.turnStopping(CHILD, { planActive: false }), null)
  assert.equal(d.turnStopping(CHILD, { planActive: true }), null)
})

test('an undecidable root stays silent instead of guessing (K5)', () => {
  const d = createDecider({ isRoot: undefined, execTools: DEFAULT_EXEC_TOOLS, debounceMs: 0, now: () => 0 })
  d.claim(ROOT)
  d.toolResult(ROOT, 'write')
  assert.equal(d.turnStopping(ROOT, { planActive: false }), null)
  assert.equal(d.ask(ROOT), null)
  assert.equal(d.error(ROOT), null)
})

test('ask and error are root-gated (N2)', () => {
  const d = decider()
  assert.equal(d.ask(ROOT), 'ask')
  assert.equal(d.error(ROOT), 'fail')
  assert.equal(d.ask(CHILD), null)
  assert.equal(d.error(CHILD), null)
  assert.equal(d.ask(), 'ask')
})

test('the documented window and a disabled window behave differently (BC4)', () => {
  let clock = 10_000
  // The default wiring leaves rate limiting to the engine, so the decider must
  // not hold a second window that could narrow it.
  const open = decider()
  assert.equal(open.ask(ROOT), 'ask')
  assert.equal(open.ask(ROOT), 'ask')

  const gated = decider({ debounceMs: 2_500, now: () => clock })
  assert.equal(gated.ask(ROOT), 'ask')
  clock += 200
  assert.equal(gated.ask(ROOT), null)
  clock += 2_500
  assert.equal(gated.ask(ROOT), 'ask')
})

test('the decider window is per kind (BC4)', () => {
  let clock = 0
  const d = decider({ debounceMs: 2_500, now: () => clock })
  assert.equal(d.ask(ROOT), 'ask')
  assert.equal(d.error(ROOT), 'fail')
  assert.equal(d.ask(ROOT), null)
  assert.equal(d.error(ROOT), null)
  clock += 2_499
  assert.equal(d.ask(ROOT), null)
  clock += 1
  assert.equal(d.ask(ROOT), 'ask')
})

test('an unusable debounceMs is treated as disabled, never as an implicit default', () => {
  for (const bad of [undefined, null, Number.NaN, -1, 'soon', {}]) {
    const d = decider({ debounceMs: bad })
    assert.equal(d.ask(ROOT), 'ask', `debounceMs=${String(bad)}: first ask`)
    assert.equal(d.ask(ROOT), 'ask', `debounceMs=${String(bad)}: second ask`)
  }
})

test('turn state is inspectable and copied, never handed out live', () => {
  const d = decider()
  assert.equal(d.state(ROOT), null)
  d.claim(ROOT)
  assert.deepEqual(d.state(ROOT), { executed: false, toolCount: 0, lastTool: null })
  d.toolResult(ROOT, 'pwsh')
  d.toolResult(ROOT, 'read')
  d.toolResult(ROOT, 'write')
  const snapshot = d.state(ROOT)
  assert.deepEqual(snapshot, { executed: true, toolCount: 2, lastTool: 'write' })
  snapshot.executed = false
  assert.equal(d.state(ROOT).executed, true, 'the snapshot must be a copy')
})

test('WAV scaling at 100% returns the original file untouched (BC7)', () => {
  const io = memoryIo({ '/a/done.wav': pcmWav([32767, 16384, 0, -8192, -32768]) })
  const out = scaleWavVolume('/a/done.wav', 100, { cacheDir: CACHE_DIR, io: io.io })
  assert.equal(out, '/a/done.wav')
  assert.deepEqual(io.writes, [], 'no cache write for a no-op volume')
})

test('the default cache directory lives under the OS temp dir', () => {
  assert.ok(DEFAULT_CACHE_DIR.startsWith(tmpdir()), DEFAULT_CACHE_DIR)
  assert.equal(DEFAULT_CACHE_DIR, join(tmpdir(), 'dsh-perlica-ding'))
})

test('WAV scaling halves samples at 50% and caches under a content key (K7)', () => {
  const source = pcmWav([32767, 16384, 0, -8192, -32768])
  const io = memoryIo({ '/a/done.wav': source })
  const out = scaleWavVolume('/a/done.wav', 50, { cacheDir: CACHE_DIR, io: io.io })
  assert.equal(out, join(CACHE_DIR, cacheKeyFor(source, 50)))
  assert.deepEqual(readSamples(io.store.get(out)), [16384, 8192, 0, -4096, -16384])

  const again = scaleWavVolume('/a/done.wav', 50, { cacheDir: CACHE_DIR, io: io.io })
  assert.equal(again, out)
  assert.equal(io.writes.length, 1, 'second play reuses the cache entry')
})

test('WAV cache identity follows file content, not the file name or size (K7)', () => {
  const first = pcmWav([32767, 16384, 0, -8192, -32768])
  const second = pcmWav([-32768, -8192, 0, 16384, 32767]) // same name, same length, different audio
  assert.equal(first.length, second.length)
  assert.notEqual(contentDigest(first), contentDigest(second))
  assert.notEqual(cacheKeyFor(first, 50), cacheKeyFor(second, 50))
  assert.notEqual(cacheKeyFor(first, 50), cacheKeyFor(first, 60))

  const io = memoryIo({ '/a/done.wav': first })
  const at50 = scaleWavVolume('/a/done.wav', 50, { cacheDir: CACHE_DIR, io: io.io })
  io.store.set('/a/done.wav', second)
  const swapped = scaleWavVolume('/a/done.wav', 50, { cacheDir: CACHE_DIR, io: io.io })
  assert.notEqual(swapped, at50, 'a content swap must not reuse the old cache entry')
  assert.deepEqual(readSamples(io.store.get(swapped)), [-16384, -4096, 0, 8192, 16384])
})

test('the digest key is stable for identical bytes and differs on one changed byte', () => {
  const a = pcmWav([1, 2, 3])
  const b = pcmWav([1, 2, 4])
  assert.equal(contentDigest(a), contentDigest(Buffer.from(a)))
  assert.notEqual(contentDigest(a), contentDigest(b))
  assert.match(cacheKeyFor(a, 30), /^snd-[0-9a-f]{16}-v30\.wav$/)
})

test('non-PCM and malformed sources fall back to the original path (BC7)', () => {
  const floatish = Buffer.alloc(64)
  floatish.write('RIFF', 0, 'ascii')
  floatish.writeUInt32LE(56, 4)
  floatish.write('WAVE', 8, 'ascii')
  floatish.write('fmt ', 12, 'ascii')
  floatish.writeUInt32LE(16, 16)
  floatish.writeUInt16LE(3, 20) // IEEE float
  floatish.writeUInt16LE(1, 22)
  floatish.writeUInt32LE(44100, 24)
  floatish.writeUInt32LE(44100 * 4, 28)
  floatish.writeUInt16LE(4, 32)
  floatish.writeUInt16LE(64, 34) // unsupported depth
  floatish.write('data', 36, 'ascii')
  floatish.writeUInt32LE(12, 40)

  const io = memoryIo({
    '/a/float.wav': floatish,
    '/a/junk.wav': Buffer.from('definitely not a wave file'),
    '/a/truncated.wav': Buffer.from('RIFF'),
  })
  assert.equal(scaleWavVolume('/a/float.wav', 50, { cacheDir: CACHE_DIR, io: io.io }), '/a/float.wav')
  assert.equal(scaleWavVolume('/a/junk.wav', 50, { cacheDir: CACHE_DIR, io: io.io }), '/a/junk.wav')
  assert.equal(scaleWavVolume('/a/truncated.wav', 50, { cacheDir: CACHE_DIR, io: io.io }), '/a/truncated.wav')
  assert.equal(scaleWavVolume('/a/missing.wav', 50, { cacheDir: CACHE_DIR, io: io.io }), '/a/missing.wav')
  assert.deepEqual(io.writes, [], 'nothing unsupported is written to the cache')
})

test('a failing cache write still yields the scaled audio, and never a half-written entry (N15)', () => {
  const source = pcmWav([32767, 32767])
  const io = memoryIo({ '/a/done.wav': source })
  const failing = {
    ...io.io,
    rename: () => { throw new Error('EXDEV') },
  }
  const out = scaleWavVolume('/a/done.wav', 50, { cacheDir: CACHE_DIR, io: failing })
  assert.notEqual(out, '/a/done.wav', 'a scaled copy is still produced')
  assert.ok(
    out.startsWith(`${join(CACHE_DIR, cacheKeyFor(source, 50))}.tmp-`),
    `expected a temp path beside the cache key, got ${out}`,
  )
  assert.deepEqual(readSamples(io.store.get(out)), [16384, 16384])
})
