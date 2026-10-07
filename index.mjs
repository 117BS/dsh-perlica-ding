/**
 * dsh-perlica-ding —— Tiered task-completion sounds for DeepSeek Harness.
 *
 * Plays a distinct sound when an agent turn closes, depending on what the
 * turn was doing:
 *   - plan mode active            -> plan sound (a plan was produced)
 *   - tools were used             -> done sound (a task was executed)
 *   - plain conversation, no tools -> silent
 * Plus two immediate signals:
 *   - ask_user_question tool / approval request -> ask sound (needs your input)
 *   - agent error                              -> fail sound
 *
 * Only root (main conversation) agents trigger sounds; subagents do not
 * beep individually. Each kind has its own debounce window.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** Bundled sound directory (ships with the package: sounds/*.wav). */
const BUNDLED_SOUNDS = join(dirname(fileURLToPath(import.meta.url)), 'sounds')

/** Cache directory for volume-scaled WAV copies. */
const CACHE_DIR = join(tmpdir(), 'dsh-perlica-ding')

/**
 * Plugin-owned volume file, used when the host has no settings namespace.
 * The directory is read per call so tests and custom deployments can redirect
 * it through DSH_PERLICA_DING_STORE.
 */
const storeFile = () => join(
  process.env.DSH_PERLICA_DING_STORE || join(homedir(), '.dsh', 'dsh-perlica-ding'),
  'volume.json',
)

/** Cordis plugin name (Loader entry id). */
export const name = 'dsh-perlica-ding'

/** Hard dependency: the subprocess seam used to play sounds. */
export const inject = ['subprocess']

/**
 * Scale a WAV file's PCM samples by `volume` percent and return the path of a
 * cached copy. Pure JS: works on any platform without ffmpeg or system-volume
 * changes. Returns the original path when the format is unsupported (non-PCM,
 * exotic bit depths) or when scaling is a no-op.
 *
 * Supported: 8-bit and 16-bit PCM, including WAVE_FORMAT_EXTENSIBLE-wrapped PCM.
 */
function scaleWavVolume(srcPath, volume) {
  const gain = volume / 100
  if (gain === 1) return srcPath
  let buf
  try {
    buf = readFileSync(srcPath)
  } catch (error) {
    return srcPath
  }
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return srcPath
  }
  let offset = 12
  let audioFormat = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && chunkSize >= 16) {
      audioFormat = buf.readUInt16LE(body)
      bitsPerSample = buf.readUInt16LE(body + 14)
      // WAVE_FORMAT_EXTENSIBLE (0xFFFE): the real format is the first 2 bytes
      // of the sub-format GUID at body+24.
      if (audioFormat === 0xfffe && chunkSize >= 40 && buf.readUInt16LE(body + 24) === 1) {
        audioFormat = 1
      }
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(chunkSize, buf.length - body)
    }
    if (dataOffset >= 0 && bitsPerSample > 0) break
    offset = body + chunkSize + (chunkSize % 2)
  }
  if (dataOffset < 0 || audioFormat !== 1) return srcPath
  const out = Buffer.from(buf)
  if (bitsPerSample === 16) {
    for (let i = 0; i + 1 < dataSize; i += 2) {
      const pos = dataOffset + i
      let v = Math.round(out.readInt16LE(pos) * gain)
      if (v > 32767) v = 32767
      else if (v < -32768) v = -32768
      out.writeInt16LE(v, pos)
    }
  } else if (bitsPerSample === 8) {
    for (let i = 0; i < dataSize; i++) {
      const pos = dataOffset + i
      let v = Math.round((out.readUInt8(pos) - 128) * gain + 128)
      if (v > 255) v = 255
      else if (v < 0) v = 0
      out.writeUInt8(v, pos)
    }
  } else {
    return srcPath
  }
  // Content-addressed cache key: replacing a sound file (even with one of the
  // same size) yields a different digest, so the stale copy is never reused.
  const digest = createHash('sha1').update(buf).digest('hex').slice(0, 12)
  const dest = join(CACHE_DIR, basename(srcPath).replace(/\.wav$/i, '') + '-v' + volume + '-' + digest + '.wav')
  try {
    if (!existsSync(dest)) {
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(dest, out)
    }
    return dest
  } catch (error) {
    console.error('[dsh-perlica-ding] volume cache write failed', error)
    return srcPath
  }
}

/**
 * Tool names that count as "executing a task" — i.e. the call produces or
 * changes something outside the conversation: writes files, runs processes,
 * delegates work, delivers results. Read-only / lookup tools (read, grep,
 * glob, web_search, skill, ...) and conversation-local bookkeeping
 * (todo_write) do NOT count, so plain Q&A stays silent.
 *
 * Override via config.execTools (array of tool names; empty array = every
 * tool counts, i.e. the old behavior).
 */
const DEFAULT_EXEC_TOOLS = [
  // processes and file mutation
  'pwsh',
  'bash',
  'write',
  'edit',
  // delegation and result delivery
  'subagent',
  'subagent_fork',
  'send_message',
  'interrupt_agent',
  'workflow',
  'ralph',
  // background jobs
  'job_output',
  'job_kill',
  // interactive terminals
  'terminal_spawn',
  'terminal_send',
  'terminal_signal',
  'terminal_kill',
  // durable goal state and dynamic plugins
  'create_goal',
  'update_goal',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
]

/** Plugin configuration, validated at load by the Loader. */
export const Config = z.object({
  /** Master switch; set false to silence everything. */
  enabled: z.boolean().default(true),
  /** Minimum gap in ms between two plays of the SAME kind. */
  debounceMs: z.number().min(100).max(60000).default(2500),
  /**
   * Directory holding plan.wav / done.wav / ask.wav / fail.wav.
   * Empty string falls back to the process cwd, then to bundled OS sounds.
   */
  soundDir: z.string().default(''),
  /**
   * Playback volume in percent: 0 = silent, 100 = original sound level.
   * Implemented by rescaling the WAV PCM samples (no system-volume change,
   * no ffmpeg dependency). Non-PCM sources keep their original level.
   */
  volume: z.number().min(0).max(100).default(100),
  /**
   * Tool names that count as executing a task. Empty array = every tool
   * counts. Defaults to the built-in execution whitelist (DEFAULT_EXEC_TOOLS).
   */
  execTools: z.array(z.string()).default(DEFAULT_EXEC_TOOLS),
})

/** The four notification kinds and their user-facing labels. */
const KINDS = ['plan', 'done', 'ask', 'fail']
const KIND_LABELS = {
  plan: '计划出方案',
  done: '任务完成',
  ask: '需要你回应',
  fail: '出错',
}

/** Fallback system sounds per platform and kind. */
const SYSTEM_SOUNDS = {
  win32: {
    plan: ['C:\\Windows\\Media\\chimes.wav', 'C:\\Windows\\Media\\notify.wav'],
    done: ['C:\\Windows\\Media\\notify.wav', 'C:\\Windows\\Media\\chimes.wav'],
    ask: ['C:\\Windows\\Media\\ding.wav', 'C:\\Windows\\Media\\Windows Notify System Default.wav'],
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

/** Encode a JS string as base64 of its UTF-16LE bytes (PowerShell -EncodedCommand). */
function utf16leToBase64(text) {
  let bytes = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes += String.fromCharCode(code & 0xff, code >>> 8)
  }
  return btoa(bytes)
}

/**
 * Fold plan-mode state from the session event log: the last `plan/mode`
 * event wins; a log with none folds to inactive. Used when the `planMode`
 * service is unavailable in the current context.
 */
function foldPlanModeFromEvents(events) {
  if (!events || !events.length) return false
  let active = false
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event && event.type === 'plan/mode') {
      active = !!(event.data && event.data.active)
    }
  }
  return active
}

export function apply(ctx, config) {
  const cfg = Config(config ?? {})
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return
  const agents = ctx.get('agents')
  const planMode = ctx.get('planMode')

  const platform = process.platform
  const lastPlayed = {}
  const turnStart = new Map()
  const lastTool = new Map()

  /**
   * Runtime-adjusted volume (in-memory fallback when nothing can persist);
   * a registered settings namespace or the plugin-owned file takes precedence.
   */
  let runtimeVolume = null

  /**
   * The settings namespace owning the user-facing volume. Like the web
   * carrier, `settings` may not be active yet while this plugin applies during
   * boot, so registration goes through deferred injection.
   *
   * The host's settings service is not stable across DSH lines: 0.1.x exposes
   * a provider with `register`, while 0.2.x replaces the same service key with
   * a forms implementation that has none. The service is therefore
   * feature-detected, and a host without `register` falls back to the
   * plugin-owned file below instead of silently losing the value.
   */
  let volumeScope = null
  let fileVolume = null
  let fileVolumeLoaded = false

  const readFileVolume = () => {
    try {
      const data = JSON.parse(readFileSync(storeFile(), 'utf8'))
      if (data && typeof data.volume === 'number' && Number.isFinite(data.volume)) {
        return Math.max(0, Math.min(100, Math.round(data.volume)))
      }
    } catch (error) { /* absent or damaged: fall back to config */ }
    return null
  }

  const writeFileVolume = (volume) => {
    try {
      const dest = storeFile()
      mkdirSync(dirname(dest), { recursive: true })
      const tmp = dest + '.tmp'
      writeFileSync(tmp, JSON.stringify({ volume, savedAt: new Date().toISOString() }, null, 2))
      renameSync(tmp, dest)
      return true
    } catch (error) {
      console.error('[dsh-perlica-ding] volume file write failed', error)
      return false
    }
  }

  const useFileStore = () => {
    fileVolume = readFileVolume()
    fileVolumeLoaded = true
    console.error('[dsh-perlica-ding] persisting volume to ' + storeFile())
  }

  const registerVolumeSettings = (settingsService) => {
    if (volumeScope || fileVolumeLoaded) return
    if (!settingsService || typeof settingsService.register !== 'function') {
      // Hosts like DSH 0.2 expose a settings service without `register`.
      useFileStore()
      return
    }
    try {
      volumeScope = settingsService.register(
        'dsh-perlica-ding',
        z.object({ volume: z.number().min(0).max(100).default(100) }),
        { base: { volume: cfg.volume }, applies: 'live' },
      )
      // Carry over a value the user picked before the namespace existed.
      if (runtimeVolume !== null) {
        Promise.resolve(volumeScope.update({ volume: runtimeVolume })).catch(() => {})
      }
    } catch (error) {
      console.error('[dsh-perlica-ding] settings registration failed; using file storage', error)
      useFileStore()
    }
  }

  /** Effective volume: settings namespace -> file -> runtime -> config. */
  const currentVolume = () => {
    if (volumeScope) {
      try {
        const value = volumeScope.get()
        if (value && typeof value.volume === 'number' && Number.isFinite(value.volume)) {
          return Math.max(0, Math.min(100, Math.round(value.volume)))
        }
      } catch (error) { /* fall through to the next tier */ }
    }
    if (fileVolumeLoaded) {
      if (fileVolume === null) fileVolume = readFileVolume()
      if (fileVolume !== null) return fileVolume
    }
    if (runtimeVolume !== null) return runtimeVolume
    return cfg.volume
  }

  /** Whether this environment can store the volume across restarts. */
  const canPersist = () => !!(volumeScope || fileVolumeLoaded)

  /** Store one volume value through the active tier. Reports failures. */
  const storeVolume = async (next) => {
    if (volumeScope) {
      await volumeScope.update({ volume: next })
      return true
    }
    if (fileVolumeLoaded) {
      if (!writeFileVolume(next)) {
        throw new Error('无法写入音量文件：' + storeFile())
      }
      fileVolume = next
      return true
    }
    runtimeVolume = next
    return false
  }

  const cwdOf = (agent) => {
    try {
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
    } catch (error) {
      return undefined
    }
  }

  const isRoot = (agent) => {
    if (!agents || !agent) return true
    try {
      const roots = agents.roots()
      return roots.some((a) => a.id === agent.id)
    } catch (error) {
      return true
    }
  }

  /**
   * First existing candidate for a sound kind:
   * config soundDir -> session workspace -> bundled package sounds/ -> OS sounds.
   * Bundled sounds make the plugin work out of the box; users override by
   * dropping their own wav into the session workspace (or soundDir).
   *
   * The session workspace comes from `agent.session.header.cwd`, because
   * `process.cwd()` is the host process's directory and may be unrelated to
   * where the user keeps their files.
   *
   * Returns null when nothing exists, so no process is spawned for a missing
   * file.
   */
  const resolveSound = (kind, sessionCwd) => {
    const candidates = []
    if (cfg.soundDir) candidates.push(join(cfg.soundDir, kind + '.wav'))
    if (sessionCwd) candidates.push(join(sessionCwd, kind + '.wav'))
    candidates.push(join(BUNDLED_SOUNDS, kind + '.wav'))
    const sys = (SYSTEM_SOUNDS[platform] || {})[kind] || []
    candidates.push(...sys)
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  const spawnBeep = (attempts) => {
    let index = 0
    const tryNext = () => {
      if (index >= attempts.length) return
      const argv = attempts[index++]
      let handle
      try {
        handle = subprocess.spawn({
          argv,
          cwd: platform === 'win32' ? 'C:\\Windows' : '/',
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 3000,
        })
      } catch (error) {
        console.error('[dsh-perlica-ding] spawn failed', argv[0], error)
        tryNext()
        return
      }
      handle.done.catch((error) => {
        console.error('[dsh-perlica-ding] play process failed', argv[0], error)
        tryNext()
      })
    }
    tryNext()
  }

  /**
   * Play one sound kind.
   *
   * @param kind - which sound to play.
   * @param force - preview mode: skip the debounce so a user clicking through
   *   kinds hears every one immediately.
   * @param sessionCwd - the session workspace used to locate a custom wav.
   */
  const play = (kind, force = false, sessionCwd = undefined) => {
    if (!cfg.enabled) return
    const volume = currentVolume()
    if (volume <= 0) return
    const now = Date.now()
    if (!force && now - (lastPlayed[kind] || 0) < cfg.debounceMs) return
    lastPlayed[kind] = now
    const resolved = resolveSound(kind, sessionCwd)
    if (!resolved) {
      console.error('[dsh-perlica-ding] no sound file found for "' + kind + '"; nothing played')
      return
    }
    const file = volume < 100 ? scaleWavVolume(resolved, volume) : resolved
    if (platform === 'win32') {
      const escaped = file.replace(/'/g, "''")
      const script = "$p = New-Object Media.SoundPlayer '" + escaped + "'; $p.PlaySync()"
      const encoded = utf16leToBase64(script)
      spawnBeep([
        ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        ['pwsh.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      ])
    } else if (platform === 'darwin') {
      spawnBeep([['/usr/bin/afplay', file]])
    } else {
      spawnBeep([['paplay', file], ['aplay', file]])
    }
  }

  // --- settings page bridge (browser UI <-> host) ---------------------------
  // The client half renders a settings page with a volume slider and preview
  // buttons; it reaches this host half over a loopback HTTP route.
  //
  // `webServer` is usually NOT active yet while this plugin applies during
  // boot, so registration goes through a deferred injection: cordis runs the
  // callback once the service becomes available (and never when the deployment
  // has no web carrier — notifications keep working either way).
  const readJsonBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 65536) data = data.slice(0, 65536)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'))
      } catch (error) {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })

  let bridgeRegistered = false
  const registerBridge = (webServer, host) => {
    if (bridgeRegistered) return
    if (!webServer || !host) {
      console.error('[dsh-perlica-ding] webServer unavailable; settings page bridge disabled')
      return
    }
    try {
      host.effect(() => webServer.register({
      kind: 'prefix',
      path: '/perlica-ding/api',
      handler: async (req, res) => {
        const send = (code, payload) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        try {
          const path = (req.url || '').split('?')[0]
          const headers = req.headers || {}
          // Loopback-only surface: require a same-origin browser caller (or no
          // Origin header at all, which is how non-browser clients arrive).
          const origin = headers.origin
          if (typeof origin === 'string' && origin.length > 0) {
            let sameOrigin = false
            try {
              sameOrigin = new URL(origin).host === headers.host
            } catch (error) {
              sameOrigin = false
            }
            if (!sameOrigin) return send(403, { error: 'cross-origin request refused' })
          }
          if (req.method === 'GET' && path === '/perlica-ding/api/state') {
            return send(200, {
              volume: currentVolume(),
              enabled: cfg.enabled,
              debounceMs: cfg.debounceMs,
              persistent: canPersist(),
              kinds: KINDS.map((id) => ({ id, label: KIND_LABELS[id] })),
            })
          }
          if (req.method === 'POST') {
            const contentType = String(headers['content-type'] || '')
            if (!contentType.includes('application/json')) {
              return send(415, { error: 'content-type must be application/json' })
            }
          }
          if (req.method === 'POST' && path === '/perlica-ding/api/volume') {
            const body = await readJsonBody(req)
            const next = Math.round(Number(body && body.volume))
            if (!Number.isFinite(next) || next < 0 || next > 100) {
              return send(400, { error: 'volume must be a number between 0 and 100' })
            }
            const stored = await storeVolume(next)
            return send(200, { volume: currentVolume(), persistent: stored || canPersist() })
          }
          if (req.method === 'POST' && path === '/perlica-ding/api/preview') {
            if (!cfg.enabled) {
              return send(409, { error: '插件已停用，试听不可用' })
            }
            const body = await readJsonBody(req)
            const kind = String((body && body.kind) || '')
            if (!KINDS.includes(kind)) return send(400, { error: 'unknown sound kind' })
            play(kind, true)
            return send(200, { played: kind, volume: currentVolume() })
          }
          return send(404, { error: 'not found' })
        } catch (error) {
          return send(500, { error: String((error && error.message) || error) })
        }
      },
      }))
      bridgeRegistered = true
      console.error('[dsh-perlica-ding] settings bridge registered at /perlica-ding/api')
    } catch (error) {
      console.error('[dsh-perlica-ding] settings bridge registration failed', error)
    }
  }

  // Two shots at the web carrier: it may already be active (fast path), or it
  // may come up after this plugin applies during boot (deferred injection).
  const webServerNow = ctx.get('webServer')
  if (webServerNow) {
    registerBridge(webServerNow, ctx)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => registerBridge(scope.webServer, scope))
  } else {
    console.error('[dsh-perlica-ding] cannot defer-inject webServer; settings page bridge disabled')
  }

  // Same treatment for the settings namespace that persists the volume. When
  // no settings service is reachable at all (and none can be waited for), the
  // plugin-owned file tier takes over rather than degrading to memory.
  const settingsNow = ctx.get('settings')
  if (settingsNow) {
    registerVolumeSettings(settingsNow)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => registerVolumeSettings(scope.settings))
  } else {
    registerVolumeSettings(undefined)
  }

  ctx.on('agent/inbox/claimed', (payload) => {
    if (!payload || !isRoot(payload.agent)) return
    turnStart.set(payload.agent.id, Date.now())
  })

  ctx.on('tools/result', (exec) => {
    if (!exec || !exec.agent || !isRoot(exec.agent)) return
    // Only execution-class tools count as "doing a task". With an empty
    // execTools config every tool counts (old behavior).
    if (cfg.execTools.length > 0 && !cfg.execTools.includes(exec.name)) return
    lastTool.set(exec.agent.id, Date.now())
  })

  ctx.on('tools/execute', (exec, next) => {
    // Same root-only rule as the turn sounds: a subagent asking a question must
    // not beep the human.
    if (exec && exec.name === 'ask_user_question' && (!exec.agent || isRoot(exec.agent))) {
      play('ask', false, cwdOf(exec.agent))
    }
    return next()
  })

  ctx.on('approval/request', (req, next) => {
    const agent = req && req.agent
    if (!agent || isRoot(agent)) play('ask', false, cwdOf(agent))
    return next()
  })

  ctx.on('agent/error', (payload) => {
    if (!payload || !isRoot(payload.agent)) return
    play('fail', false, cwdOf(payload.agent))
  })

  ctx.on('agent/turn-stopping', (payload) => {
    if (!payload || !payload.agent || !isRoot(payload.agent)) return
    const id = payload.agent.id
    // Prefer the planMode service (npm environment); fall back to folding
    // the session event log when the service is not reachable (dynamic
    // plugin sandbox).
    let active = false
    if (planMode) {
      try {
        const state = planMode.get(payload.agent)
        active = !!(state && state.active)
      } catch (error) { /* ignore */ }
    } else {
      try {
        const events = payload.agent.session && payload.agent.session.events
        active = foldPlanModeFromEvents(events)
      } catch (error) { /* ignore */ }
    }
    try {
      if (active) {
        play('plan', false, cwdOf(payload.agent))
      } else {
        const start = turnStart.get(id) || 0
        const tool = lastTool.get(id) || 0
        if (tool >= start) play('done', false, cwdOf(payload.agent))
      }
    } catch (error) {
      console.error('[dsh-perlica-ding] turn-stopping handler failed', error)
    } finally {
      turnStart.delete(id)
      lastTool.delete(id)
    }
  })
}
