/**
 * Volume-scaling verification for dsh-perlica-ding.
 * Builds a synthetic 16-bit stereo WAV with known samples, runs the plugin's
 * scaleWavVolume through a full apply() play cycle, and asserts the rescaled
 * samples match the expected amplitude.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply } from '../index.mjs'

let failed = 0
function assert(cond, label) {
  if (cond) console.log(`  PASS ${label}`)
  else { console.error(`  FAIL ${label}`); failed++ }
}

/** Build a minimal 16-bit PCM WAV with the given samples (mono). */
function makeWav(samples, sampleRate = 8000) {
  const dataSize = samples.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2))
  return buf
}

/** Read PCM samples back out of a WAV. */
function readSamples(path) {
  const buf = readFileSync(path)
  const dataSize = buf.readUInt32LE(40)
  const out = []
  for (let i = 0; i + 1 < dataSize; i += 2) out.push(buf.readInt16LE(44 + i))
  return out
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-perlica-vol-'))
// Known samples: full-scale positive, half, silence, quarter negative, full negative
const SOURCE = [32767, 16384, 0, -8192, -32768]
writeFileSync(join(dir, 'done.wav'), makeWav(SOURCE))
writeFileSync(join(dir, 'plan.wav'), makeWav(SOURCE))
writeFileSync(join(dir, 'ask.wav'), makeWav(SOURCE))
writeFileSync(join(dir, 'fail.wav'), makeWav(SOURCE))

/** Drive one play and capture the file that was actually played. */
function playAndCapture(volume) {
  const handlers = {}
  let played = null
  const ctx = {
    get(service) {
      if (service === 'subprocess') {
        return {
          spawn(spec) {
            // Windows path encodes the file inside a PowerShell -EncodedCommand
            const encoded = spec.argv[spec.argv.length - 1]
            const script = Buffer.from(encoded, 'base64').toString('utf16le')
            const m = script.match(/'([^']+\.wav)'/)
            played = m ? m[1] : null
            return { done: new Promise(() => {}) }
          },
        }
      }
      if (service === 'agents') return { roots: () => [{ id: 'root' }] }
      return undefined
    },
    on(event, listener) { handlers[event] = listener },
  }
  const cfg = Config({ soundDir: dir, debounceMs: 100, volume })
  // Force the windows branch regardless of the host OS
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  apply(ctx, cfg)
  handlers['agent/inbox/claimed']({ agent: { id: 'root' } })
  handlers['tools/result']({ agent: { id: 'root' }, name: 'write' })
  handlers['agent/turn-stopping']({ agent: { id: 'root' } })
  return played
}

console.log('volume scaling:')
const at100 = playAndCapture(100)
assert(at100 === join(dir, 'done.wav'), 'volume 100 plays the original file unchanged')

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
const at50 = playAndCapture(50)
assert(at50 !== null && at50.includes('-v50-'), `volume 50 plays a scaled copy (got ${at50 ? at50.split('\\').pop() : 'null'})`)
if (at50 && existsSync(at50)) {
  const got = readSamples(at50)
  const expected = SOURCE.map((s) => Math.max(-32768, Math.min(32767, Math.round(s * 0.5))))
  assert(JSON.stringify(got) === JSON.stringify(expected), `samples halved correctly: ${JSON.stringify(got)}`)
}

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
const at25 = playAndCapture(25)
if (at25 && existsSync(at25)) {
  const got = readSamples(at25)
  const expected = SOURCE.map((s) => Math.max(-32768, Math.min(32767, Math.round(s * 0.25))))
  assert(JSON.stringify(got) === JSON.stringify(expected), `samples quartered: ${JSON.stringify(got)}`)
}

// cache reuse: same volume must not rewrite the file (same path returned)
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
const again = playAndCapture(25)
assert(again === at25, 'scaled copy is reused from cache')

// volume 0 must play nothing at all
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
const atZero = playAndCapture(0)
assert(atZero === null, 'volume 0 stays silent (nothing spawned)')

// unsupported (non-WAV) source falls back to the original path
const junk = join(dir, 'junk.wav')
writeFileSync(junk, Buffer.from('not a wave file at all, just text'))
const dir2 = mkdtempSync(join(tmpdir(), 'dsh-perlica-vol2-'))
writeFileSync(join(dir2, 'done.wav'), readFileSync(junk))
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
const handlers2 = {}
let played2 = null
const ctx2 = {
  get(service) {
    if (service === 'subprocess') {
      return {
        spawn(spec) {
          const script = Buffer.from(spec.argv[spec.argv.length - 1], 'base64').toString('utf16le')
          const m = script.match(/'([^']+\.wav)'/)
          played2 = m ? m[1] : null
          return { done: new Promise(() => {}) }
        },
      }
    }
    if (service === 'agents') return { roots: () => [{ id: 'root' }] }
    return undefined
  },
  on(event, listener) { handlers2[event] = listener },
}
apply(ctx2, Config({ soundDir: dir2, debounceMs: 100, volume: 40 }))
handlers2['agent/inbox/claimed']({ agent: { id: 'root' } })
handlers2['tools/result']({ agent: { id: 'root' }, name: 'write' })
handlers2['agent/turn-stopping']({ agent: { id: 'root' } })
assert(played2 === join(dir2, 'done.wav'), 'non-WAV source falls back to the original file')

console.log(failed === 0 ? '\nALL VOLUME TESTS PASSED' : `\n${failed} TEST(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
