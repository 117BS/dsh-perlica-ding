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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name (Loader entry id). */
export const name = 'dsh-perlica-ding'

/** Hard dependency: the subprocess seam used to play sounds. */
export const inject = ['subprocess']

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
   * Tool names that count as executing a task. Empty array = every tool
   * counts. Defaults to the built-in execution whitelist (DEFAULT_EXEC_TOOLS).
   */
  execTools: z.array(z.string()).default(DEFAULT_EXEC_TOOLS),
})

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
  return Buffer.from(text, 'utf16le').toString('base64')
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

  const isRoot = (agent) => {
    if (!agents || !agent) return true
    try {
      const roots = agents.roots()
      return roots.some((a) => a.id === agent.id)
    } catch (error) {
      return true
    }
  }

  /** First existing candidate for a sound kind: config dir -> cwd -> OS sounds. */
  const resolveSound = (kind) => {
    const candidates = []
    if (cfg.soundDir) candidates.push(join(cfg.soundDir, kind + '.wav'))
    candidates.push(join(process.cwd(), kind + '.wav'))
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

  const play = (kind) => {
    if (!cfg.enabled) return
    const now = Date.now()
    if (now - (lastPlayed[kind] || 0) < cfg.debounceMs) return
    lastPlayed[kind] = now
    const file = resolveSound(kind)
    if (!file) return
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
    let active = false
    if (planMode) {
      try {
        const state = planMode.get(payload.agent)
        active = !!(state && state.active)
      } catch (error) { /* ignore */ }
    }
    if (active) {
      play('plan')
    } else {
      const start = turnStart.get(id) || 0
      const tool = lastTool.get(id) || 0
      if (tool >= start) play('done')
    }
    turnStart.delete(id)
    lastTool.delete(id)
  })
}
