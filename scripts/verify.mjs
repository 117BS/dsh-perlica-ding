/**
 * Offline smoke test for dsh-perlica-ding.
 * Mocks a minimal Cordis ctx and drives the event sequence for each scenario,
 * asserting which sound kind would have played. No DSH runtime required.
 */
import { name, inject, Config, apply } from '../index.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function assert(cond, label) {
  if (cond) {
    console.log(`  PASS ${label}`)
  } else {
    console.error(`  FAIL ${label}`)
    failed++
  }
}

// --- sandbox: temp sound dir with dummy wav files (only existence matters) ---
const dir = mkdtempSync(join(tmpdir(), 'dsh-perlica-ding-'))
for (const kind of ['plan', 'done', 'ask', 'fail']) {
  writeFileSync(join(dir, kind + '.wav'), 'not really audio, just a file')
}

// --- fake agent ---
const rootAgent = { id: 'root-session' }
const childAgent = { id: 'child-session' }

// --- mock ctx ---
const handlers = {}
const ctx = {
  get(service) {
    if (service === 'subprocess') {
      return {
        spawn(spec) {
          // record the last attempted argv for assertions
          ctx._lastSpawn = spec.argv
          return { done: new Promise(() => {}) }
        },
      }
    }
    if (service === 'agents') {
      return { roots: () => [rootAgent] }
    }
    if (service === 'planMode') {
      return { get: () => ({ active: ctx._planActive === true }) }
    }
    return undefined
  },
  on(event, listener) {
    handlers[event] = listener
  },
  _lastSpawn: null,
  _planActive: false,
}

// --- structural contract ---
console.log('contract:')
assert(name === 'dsh-perlica-ding', `name is "${name}"`)
assert(Array.isArray(inject) && inject.includes('subprocess'), 'inject declares subprocess')
assert(Config != null, 'Config schema exported')
assert(typeof apply === 'function', 'apply is a function')

const cfg = Config({ soundDir: dir, debounceMs: 100 })
assert(cfg.enabled === true && cfg.debounceMs === 100 && cfg.soundDir === dir, 'Config defaults + overrides')

// --- scenario helpers ---
const fire = (event, ...args) => handlers[event](...args)

apply(ctx, cfg)

function scenario(label, steps, expected) {
  console.log(`scenario: ${label}`)
  ctx._lastSpawn = null
  for (const step of steps) fire(...step)
  const played = ctx._lastSpawn
  if (expected === 'none') {
    assert(played === null, 'nothing played')
  } else {
    assert(played !== null, `something played for ${expected}`)
    if (played) {
      const script = played[played.length - 1]
      const decoded = Buffer.from(script, 'base64').toString('utf16le')
      assert(decoded.includes(expected + '.wav'), `plays ${expected}.wav (got: ${decoded.match(/\w+\.wav/)?.[0] ?? '?'})`)
    }
  }
}

// 1. plan mode active -> plan
ctx._planActive = true
scenario('plan mode produces plan', [
  ['agent/inbox/claimed', { agent: rootAgent }],
  ['agent/turn-stopping', { agent: rootAgent }],
], 'plan')
ctx._planActive = false

// 2. tool used -> done
scenario('task with tools -> done', [
  ['agent/inbox/claimed', { agent: rootAgent }],
  ['tools/result', { agent: rootAgent }],
  ['agent/turn-stopping', { agent: rootAgent }],
], 'done')

// 3. plain chat -> silent
scenario('plain chat -> silent', [
  ['agent/inbox/claimed', { agent: rootAgent }],
  ['agent/turn-stopping', { agent: rootAgent }],
], 'none')

// 4. ask tool -> ask
scenario('ask_user_question -> ask', [
  ['tools/execute', { name: 'ask_user_question' }, () => {}],
], 'ask')

// debounce window between same-kind sounds: wait it out
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)

// 5. approval -> ask
scenario('approval request -> ask', [
  ['approval/request', {}, () => {}],
], 'ask')
// 6. error -> fail
scenario('agent error -> fail', [
  ['agent/error', { agent: rootAgent }],
], 'fail')

// 7. subagent turn-stopping is ignored
scenario('subagent turn -> silent', [
  ['agent/inbox/claimed', { agent: childAgent }],
  ['tools/result', { agent: childAgent }],
  ['agent/turn-stopping', { agent: childAgent }],
], 'none')

console.log(failed === 0 ? '\nALL TESTS PASSED' : `\n${failed} TEST(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
