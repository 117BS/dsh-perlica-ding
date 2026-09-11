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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** Bundled sound directory (ships with the package: sounds/*.wav). */
const BUNDLED_SOUNDS = join(dirname(fileURLToPath(import.meta.url)), 'sounds')

/** Cache directory for volume-scaled WAV copies. */
const CACHE_DIR = join(tmpdir(), 'dsh-perlica-ding')

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
  const dest = join(CACHE_DIR, basename(srcPath).replace(/\.wav$/i, '') + '-v' + volume + '-' + buf.length + '.wav')
  try {
    if (!existsSync(dest)) {
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(dest, out)
    }
    return dest
  } catch (error) {
    console.error('dsh-perlica-ding: volume cache write failed', error)
    return srcPath
  }
}

/**
 * Tool names that count as "executing a task". Read-only / lookup tools
 * (read, grep, glob, web_search, skill, ...) do NOT count: a plain Q&A that
 * happens to consult a file or search the web stays silent.
 *
 * Override via config.execTools (array of tool names; empty array = every
 * tool counts, i.e. the old behavior).
 */
const DEFAULT_EXEC_TOOLS = [
  'pwsh',
  'bash',
  'write',
  'edit',
  'subagent',
  'subagent_fork',
  'workflow',
  'ralph',
  'job_kill',
  'create_goal',
  'update_goal',
  'todo_write',
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
  const settings = ctx.get('settings')
  const webServer = ctx.get('webServer')

  const platform = process.platform
  const lastPlayed = {}
  const turnStart = new Map()
  const lastTool = new Map()

  /**
   * Runtime-adjusted volume (in-memory fallback when the settings service is
   * unavailable); the settings namespace takes precedence when registered.
   */
  let runtimeVolume = null

  /** The settings namespace owning the user-facing volume, when available. */
  let volumeScope = null
  if (settings) {
    try {
      volumeScope = settings.register(
        'dsh-perlica-ding',
        z.object({ volume: z.number().min(0).max(100).default(100) }),
        { base: { volume: cfg.volume }, applies: 'live' },
      )
    } catch (error) {
      console.error('dsh-perlica-ding: settings registration failed', error)
    }
  }

  /** Effective volume: user setting -> runtime value -> config -> 100. */
  const currentVolume = () => {
    if (volumeScope) {
      try {
        const value = volumeScope.get()
        if (value && typeof value.volume === 'number' && Number.isFinite(value.volume)) {
          return Math.max(0, Math.min(100, Math.round(value.volume)))
        }
      } catch (error) { /* fall through to config */ }
    }
    if (runtimeVolume !== null) return runtimeVolume
    return cfg.volume
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
   * config soundDir -> workspace cwd -> bundled package sounds/ -> OS sounds.
   * Bundled sounds make the plugin work out of the box; users override by
   * dropping their own wav into the workspace (or soundDir).
   */
  const resolveSound = (kind) => {
    const candidates = []
    if (cfg.soundDir) candidates.push(join(cfg.soundDir, kind + '.wav'))
    candidates.push(join(process.cwd(), kind + '.wav'))
    candidates.push(join(BUNDLED_SOUNDS, kind + '.wav'))
    const sys = (SYSTEM_SOUNDS[platform] || {})[kind] || []
    candidates.push(...sys)
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return candidates[0] || null
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
        console.error('dsh-perlica-ding: spawn failed', argv[0], error)
        tryNext()
        return
      }
      handle.done.catch((error) => {
        console.error('dsh-perlica-ding: play process failed', argv[0], error)
        tryNext()
      })
    }
    tryNext()
  }

  /**
   * Play one sound kind. `force` (used by the settings-page preview) skips the
   * debounce so a user clicking through kinds hears every one immediately.
   */
  const play = (kind, force = false) => {
    if (!cfg.enabled) return
    const volume = currentVolume()
    if (volume <= 0) return
    const now = Date.now()
    if (!force && now - (lastPlayed[kind] || 0) < cfg.debounceMs) return
    lastPlayed[kind] = now
    const resolved = resolveSound(kind)
    if (!resolved) return
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
      console.error('dsh-perlica-ding: webServer unavailable; settings page bridge disabled')
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
          if (req.method === 'GET' && path === '/perlica-ding/api/state') {
            return send(200, {
              volume: currentVolume(),
              enabled: cfg.enabled,
              debounceMs: cfg.debounceMs,
              persistent: !!volumeScope,
              kinds: KINDS.map((id) => ({ id, label: KIND_LABELS[id] })),
            })
          }
          if (req.method === 'POST' && path === '/perlica-ding/api/volume') {
            const body = await readJsonBody(req)
            const next = Math.round(Number(body && body.volume))
            if (!Number.isFinite(next) || next < 0 || next > 100) {
              return send(400, { error: 'volume must be a number between 0 and 100' })
            }
            if (volumeScope) {
              await volumeScope.update({ volume: next })
            } else {
              runtimeVolume = next
            }
            return send(200, { volume: currentVolume() })
          }
          if (req.method === 'POST' && path === '/perlica-ding/api/preview') {
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
      console.error('dsh-perlica-ding: settings bridge registered at /perlica-ding/api')
    } catch (error) {
      console.error('dsh-perlica-ding: settings bridge registration failed', error)
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
    console.error('dsh-perlica-ding: cannot defer-inject webServer; settings page bridge disabled')
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
    if (exec && exec.name === 'ask_user_question') play('ask')
    return next()
  })

  ctx.on('approval/request', (req, next) => {
    play('ask')
    return next()
  })

  ctx.on('agent/error', (payload) => {
    if (!payload || !isRoot(payload.agent)) return
    play('fail')
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
        play('plan')
      } else {
        const start = turnStart.get(id) || 0
        const tool = lastTool.get(id) || 0
        if (tool >= start) play('done')
      }
    } catch (error) {
      console.error('dsh-perlica-ding: turn-stopping handler failed', error)
    } finally {
      turnStart.delete(id)
      lastTool.delete(id)
    }
  })
}
