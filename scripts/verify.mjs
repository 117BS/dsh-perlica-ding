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
const rootAgent = { id: 'root-session', session: { events: [] } }
const childAgent = { id: 'child-session', session: { events: [] } }

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

// 1b. planMode service missing -> fold plan/mode from session events
const rootAgentFolded = {
  id: 'folded-session',
  session: { events: [
    { type: 'message/send', data: {} },
    { type: 'plan/mode', data: { active: true } },
  ] },
}
const handlers3 = {}
const ctx3 = {
  get(service) {
    if (service === 'subprocess') {
      return {
        spawn(spec) {
          ctx3._lastSpawn = spec.argv
          return { done: new Promise(() => {}) }
        },
      }
    }
    if (service === 'agents') {
      return { roots: () => [rootAgentFolded] }
    }
    return undefined // no planMode service
  },
  on(event, listener) { handlers3[event] = listener },
  _lastSpawn: null,
}
const cfg3 = Config({ soundDir: dir, debounceMs: 100 })
apply(ctx3, cfg3)
console.log('scenario: plan mode via session event fold (no service)')
ctx3._lastSpawn = null
handlers3['agent/inbox/claimed']({ agent: rootAgentFolded })
handlers3['agent/turn-stopping']({ agent: rootAgentFolded })
const played3 = ctx3._lastSpawn
assert(played3 !== null, 'something played for plan (folded)')
if (played3) {
  const script3 = played3[played3.length - 1]
  const decoded3 = Buffer.from(script3, 'base64').toString('utf16le')
  assert(decoded3.includes('plan.wav'), `plays plan.wav (got: ${decoded3.match(/\w+\.wav/)?.[0] ?? '?'})`)
}

// 2. exec tool used -> done
scenario('task with exec tools -> done', [
  ['agent/inbox/claimed', { agent: rootAgent }],
  ['tools/result', { agent: rootAgent, name: 'write' }],
  ['agent/turn-stopping', { agent: rootAgent }],
], 'done')

// 3. plain chat -> silent
scenario('plain chat -> silent', [
  ['agent/inbox/claimed', { agent: rootAgent }],
  ['agent/turn-stopping', { agent: rootAgent }],
], 'none')

// 3b. Q&A that only used lookup tools (web_search/read) -> silent
scenario('chat with lookup tools only -> silent', [
  ['agent/inbox/claimed', { agent: rootAgent }],
  ['tools/result', { agent: rootAgent, name: 'web_search' }],
  ['tools/result', { agent: rootAgent, name: 'read' }],
  ['agent/turn-stopping', { agent: rootAgent }],
], 'none')

// 3c. old behavior: execTools = [] makes every tool count
const handlers2 = {}
const ctx2 = {
  get(service) {
    if (service === 'subprocess') {
      return {
        spawn(spec) {
          ctx2._lastSpawn = spec.argv
          return { done: new Promise(() => {}) }
        },
      }
    }
    if (service === 'agents') return { roots: () => [rootAgent] }
    if (service === 'planMode') return { get: () => ({ active: ctx2._planActive === true }) }
    return undefined
  },
  on(event, listener) { handlers2[event] = listener },
  _lastSpawn: null,
  _planActive: false,
}
const cfgAll = Config({ soundDir: dir, debounceMs: 100, execTools: [] })
apply(ctx2, cfgAll)
const fire2 = (event, ...args) => handlers2[event](...args)
console.log('scenario: execTools=[] keeps legacy behavior')
ctx2._lastSpawn = null
fire2('agent/inbox/claimed', { agent: rootAgent })
fire2('tools/result', { agent: rootAgent, name: 'web_search' })
fire2('agent/turn-stopping', { agent: rootAgent })
assert(ctx2._lastSpawn !== null, 'something played (legacy: lookup tool counts)')

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
