/**
 * Shared host activation for both channels.
 *
 * Two entries import this module — the native Cordis entry (entry-native.mjs) and
 * the dsh-std host facet (facet-std.mjs). Both call `activateHost`, and the
 * module-scope activation token below makes exactly one of them win: Node's ESM
 * cache evaluates a module once per resolved URL, so a package that is reachable
 * through both channels still plays and writes once (ADR 0001 §3.1/§4.1).
 *
 * Nothing here reads the Loader's internal structure; the token is a plain
 * module-scope value, which keeps the plugin free of undeclared private APIs.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_DEFAULTS } from '../core/defaults.mjs'
import { KIND_LABELS, KINDS } from '../core/kinds.mjs'
import { createDecider } from '../core/scenarios.mjs'
import { clampVolume, normalizeVolume } from '../core/volume.mjs'
import { createEngine, createSoundResolver } from './engine.mjs'
import { createVolumeStore, dshStorageDomainProvider, fileStoreProvider } from './store.mjs'
import { nativeRoute } from './transport-native.mjs'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLED_SOUNDS = join(PACKAGE_ROOT, 'sounds')

/** {AUDIO} Fallback system sounds per platform and kind. */
const SYSTEM_SOUNDS = {
  win32: {
    plan: ['C:\\Windows\\Media\\chimes.wav', 'C:\\Windows\\Media\\notify.wav'],
    done: ['C:\\Windows\\Media\\notify.wav', 'C:\\Windows\\Media\\chimes.wav'],
    ask: ['C:\\Windows\\Media\\ding.wav', 'C:\\Windows\\Media\\Notify System Generic.wav'],
    fail: ['C:\\Windows\\Media\\Windows Ding.wav'],
  },
  darwin: {
    plan: ['/System/Library/Sounds/Ping.aiff', '/System/Library/Sounds/Glass.aiff'],
    done: ['/System/Library/Sounds/Glass.aiff', '/System/Library/Sounds/Ping.aiff'],
    ask: ['/System/Library/Sounds/Pop.aiff'],
    fail: ['/System/Library/Sounds/Basso.aiff'],
  },
  linux: {
    plan: ['/usr/share/sounds/freedesktop/stereo/complete.oga', '/usr/share/sounds/freedesktop/stereo/bell.oga'],
    done: ['/usr/share/sounds/freedesktop/stereo/complete.oga'],
    ask: ['/usr/share/sounds/freedesktop/stereo/message-new-instant.oga'],
    fail: ['/usr/share/sounds/freedesktop/stereo/dialog-error.oga'],
  },
}

// --- activation token -------------------------------------------------------

let activeChannel = null
let activeDispose = null
let activeStatus = { state: 'idle' }

/** Which channel currently owns the process, for diagnostics and the load test. */
export function activationState() {
  return activeChannel
}

/** Facet projection consumed by the dsh-std adapter's snapshot. */
export function hostSnapshot() {
  return { ...activeStatus }
}

function claim(channel, log) {
  if (activeChannel !== null) {
    log('warn', `activation already held by "${activeChannel}" channel; "${channel}" stays inactive`)
    return false
  }
  activeChannel = channel
  return true
}

function release(channel) {
  if (activeChannel === channel) {
    activeChannel = null
    activeDispose = null
    activeStatus = { state: 'idle' }
  }
}

/** Facet deactivation: tear the shared activation down. */
export async function deactivateHost(reason) {
  const dispose = activeDispose
  if (dispose === undefined) return
  try {
    await dispose()
  } finally {
    activeStatus = { state: 'idle', message: `deactivated: ${String(reason ?? 'unspecified')}` }
  }
}

// --- helpers ----------------------------------------------------------------

/** Fold plan-mode state from the session event log (fallback when planMode is unreachable). */
function foldPlanModeFromEvents(events) {
  if (!Array.isArray(events)) return false
  let active = false
  for (const event of events) {
    if (event && event.type === 'plan/mode' && event.data) active = Boolean(event.data.active)
  }
  return active
}

function withStatus(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Sound lookup order (BC6): configured directory, the session workspace, the
 * bundled sounds, then the OS sounds.
 *
 * The first three are `<dir>/<kind>.wav` and go through the engine's resolver;
 * the OS fallback uses per-kind file names, so it stays here. The workspace step
 * is the one upstream got wrong: it used `process.cwd()`, which is the host
 * process's cwd (an Electron main process), not the session's working directory
 * (T3 K3).
 */
function createResolver({ soundDir, platform, cwdOf }) {
  return (kind) => {
    const candidates = []
    if (soundDir) candidates.push(soundDir)
    const cwd = cwdOf()
    if (typeof cwd === 'string' && cwd.length > 0) candidates.push(cwd)
    candidates.push(BUNDLED_SOUNDS)
    const found = createSoundResolver({ candidates })(kind)
    if (found !== null) return found
    for (const candidate of SYSTEM_SOUNDS[platform]?.[kind] ?? []) {
      if (existsSync(candidate)) return candidate
    }
    // Never hand back a path that does not exist: upstream returned `candidates[0]`
    // and made the player fail on every turn (T3 N13).
    return null
  }
}

// --- activation -------------------------------------------------------------

/**
 * Activate the notification host on `ctx`.
 *
 * @param ctx - Cordis context of the winning channel.
 * @param rawConfig - resolved plugin configuration, or undefined for a caller with no schema.
 * @param options.channel - 'native' | 'std'.
 * @param options.storageProviders - extra persistence providers, highest priority first.
 * @returns a disposer.
 */
export async function activateHost(ctx, rawConfig, options = {}) {
  const channel = options.channel ?? 'native'
  const log = channelLogger(ctx)
  try {
    return await runActivation(ctx, rawConfig, options, channel, log)
  } catch (error) {
    // A failure after the claim must not poison the token: without this, one throwing
    // activation leaves the plugin permanently dead for the rest of the process — and
    // the second channel would silently refuse to take over.
    log('error', 'activation failed; releasing the activation token', error)
    release(channel)
    throw error
  }
}

/** Scoped logger: the host logger when available, console for warnings and errors otherwise. */
function channelLogger(ctx) {
  const scoped = ctx?.logger ? ctx.logger('dsh-perlica-ding') : undefined
  return (level, message, error) => {
    const line = `[dsh-perlica-ding] ${message}`
    if (scoped && typeof scoped[level] === 'function') {
      if (error === undefined) scoped[level](line)
      else scoped[level](line, error)
      return
    }
    if (level === 'warn' || level === 'error') console.error(line, error ?? '')
  }
}

/** The activation body; `activateHost` owns the activation-token lifecycle around it. */
async function runActivation(ctx, rawConfig, options, channel, log) {
  // One source of truth for defaults (lib/core/defaults.mjs), shared with the
  // schemastery Config the native channel resolves. A std caller has no schema to
  // resolve — passing `undefined` here used to crash on the first `config.volume` read.
  const config = { ...CONFIG_DEFAULTS, ...(rawConfig ?? {}) }

  if (!claim(channel, log)) return () => Promise.resolve()

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    log('error', 'subprocess service is unavailable; notifications stay silent')
    release(channel)
    return () => Promise.resolve()
  }

  const platform = process.platform
  const agents = ctx.get('agents')
  const planMode = ctx.get('planMode')
  const warnings = new Set()
  const warnOnce = (key, message, error) => {
    if (warnings.has(key)) return
    warnings.add(key)
    log('warn', message, error)
  }

  // Resolved lazily at event time: at activation the service may still be coming
  // up, and a permanently silent plugin would be a worse failure than an extra
  // beep. A genuinely undeterminable root agent is logged once, not swallowed.
  const isRootRef = (candidate) => {
    const id = typeof candidate === 'string' ? candidate : candidate?.id
    const service = ctx.get('agents') ?? agents
    if (service === undefined || typeof service.roots !== 'function') {
      warnOnce('agents', 'agents service unavailable; treating every agent as root')
      return true
    }
    try {
      const roots = service.roots()
      if (!Array.isArray(roots)) return true
      if (roots.length === 0) return true
      return roots.some((root) => root && root.id === id)
    } catch (error) {
      warnOnce('agents-roots', 'agents.roots() failed; treating the agent as root', error)
      return true
    }
  }

  // --- persistence ----------------------------------------------------------
  const stateDir = join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'dsh-perlica-ding')
  const providers = [
    ...(options.storageProviders ?? []),
    dshStorageDomainProvider(ctx),
    fileStoreProvider({ stateDir }),
  ]
  const store = createVolumeStore({ providers, logger: { warn: (m, e) => warnOnce('store', m, e), error: (m, e) => log('error', m, e) } })

  let current = config.volume
  try {
    const persisted = await store.read()
    if (persisted && Number.isFinite(persisted.volume)) {
      current = persisted.source === 'default' ? config.volume : clampVolume(persisted.volume)
    }
  } catch (error) {
    log('error', 'reading the persisted volume failed; falling back to the configured value', error)
  }
  const capabilities = () => {
    try {
      return store.capabilities()
    } catch {
      return { persistent: false, kind: 'none' }
    }
  }
  const currentVolume = () => current

  // --- playback -------------------------------------------------------------
  const lastCwd = new Map()
  const resolveSound = createResolver({
    soundDir: config.soundDir,
    platform,
    cwdOf: () => {
      for (const value of lastCwd.values()) if (typeof value === 'string' && value.length > 0) return value
      return undefined
    },
  })

  // The engine owns argv, cwd and the grace window (see playbackAttempts); this
  // adapter only executes one attempt through the host subprocess seam.
  const spawn = (argv, { cwd, graceMs } = {}) => {
    const handle = subprocess.spawn({
      argv,
      cwd: cwd ?? (platform === 'win32' ? 'C:\\Windows' : '/'),
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: graceMs ?? 3000,
    })
    // `done` resolves for any exit code; only a real spawn failure rejects, so a
    // rejection here is diagnostic and must not be rethrown (T3 N7).
    handle.done.catch((error) => warnOnce('spawn', `playback process failed (${argv?.[0]})`, error))
    return handle
  }

  const engine = createEngine({
    platform,
    resolveSound,
    spawn,
    debounceMs: config.debounceMs,
    currentVolume,
  })

  const play = (kind, force = false) => {
    if (!config.enabled) return
    try {
      engine.play(kind, { force })
    } catch (error) {
      warnOnce('play', 'playback failed', error)
    }
  }

  // Debounce belongs to the engine alone: a second window inside the decider
  // would swallow decisions the engine had already agreed to play.
  const decider = createDecider({ isRoot: isRootRef, execTools: config.execTools })

  // --- event wiring ---------------------------------------------------------
  ctx.on('agent/inbox/claimed', (payload) => {
    const agent = payload?.agent
    if (!agent) return
    const cwd = agent.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) lastCwd.set(agent.id, cwd)
    decider.claim(agent.id)
  })

  ctx.on('tools/result', (exec) => {
    if (!exec?.agent) return
    decider.toolResult(exec.agent.id, exec.name)
  })

  ctx.on('tools/execute', (exec, next) => {
    if (exec?.name === 'ask_user_question' && isRootRef(exec.agent)) play('ask')
    return next()
  })

  ctx.on('approval/request', (_req, next) => {
    play('ask')
    return next()
  })

  ctx.on('agent/error', (payload) => {
    if (!payload?.agent) return
    if (!isRootRef(payload.agent)) return
    play('fail')
  })

  ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload?.agent
    if (!agent) return
    if (!isRootRef(agent)) return
    let planActive
    if (planMode !== undefined) {
      try {
        planActive = Boolean(planMode.get(agent)?.active)
      } catch (error) {
        // Upstream treated a throwing planMode as "not a plan turn"; folding the
        // session log instead keeps the plan sound reachable.
        warnOnce('planMode', 'planMode.get() failed; folding the session event log instead', error)
        planActive = foldPlanModeFromEvents(agent.session?.events)
      }
    } else {
      planActive = foldPlanModeFromEvents(agent.session?.events)
    }
    const kind = decider.turnStopping(agent.id, { planActive })
    if (kind) play(kind)
  })

  // --- settings page transport (native channel) -----------------------------
  const handlers = {
    getState: async () => ({
      volume: currentVolume(),
      enabled: config.enabled,
      debounceMs: config.debounceMs,
      persistent: capabilities().persistent,
      kind: capabilities().kind,
      kinds: KINDS.map((id) => ({ id, label: KIND_LABELS[id] })),
    }),
    setVolume: async (raw) => {
      let next
      try {
        next = normalizeVolume(raw)
      } catch (error) {
        throw withStatus(400, String(error.message || error))
      }
      try {
        await store.write(next)
      } catch (error) {
        // Never report success for a write that did not land (ADR 0001 §6).
        throw withStatus(500, `saving the volume failed: ${String(error.message || error)}`)
      }
      current = next
      return { volume: current }
    },
    preview: async (kind) => {
      const id = String(kind ?? '')
      if (!KINDS.includes(id)) throw withStatus(400, 'unknown sound kind')
      // The master switch lives in the composition config, not in this page: with
      // `enabled: false` nothing plays, so claiming `played` would be a lie the user
      // hears as silence. Refuse instead — the page surfaces the error.
      if (!config.enabled) throw withStatus(409, 'notifications are disabled (set enabled: true in the plugin config)')
      play(id, true)
      return { played: id }
    },
  }

  const webServerNow = ctx.get('webServer')
  if (webServerNow !== undefined) {
    ctx.effect(() => webServerNow.register(nativeRoute(handlers)))
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => sctx.webServer.register(nativeRoute(handlers)))
    })
  } else {
    warnOnce('webServer', 'webServer is unreachable; the settings page will not load')
  }

  activeStatus = { state: 'active', message: `channel=${channel} persistence=${capabilities().kind}` }

  const dispose = async () => {
    try {
      await store.dispose?.()
    } catch (error) {
      log('warn', 'closing the volume store failed', error)
    }
    release(channel)
  }
  activeDispose = dispose
  return dispose
}
