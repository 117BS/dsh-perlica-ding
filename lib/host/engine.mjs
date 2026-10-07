/**
 * The playback engine: turn a decided kind into a sound coming out of the
 * speakers, on the platform's own audio path.
 *
 * Everything environmental is injected — platform, the sound lookup, the
 * process spawner, the volume source, the clock — so this file contains no
 * `process.platform` deferral to the caller's wishes, no `process.cwd()` guess,
 * and no dependency on the harness. The adapter that owns the real Cordis
 * services passes the real implementations in (see the `spawn` contract below).
 *
 * **Why no `process.cwd()`.** The desktop host process runs with a profile
 * directory as its working directory, never the user's workspace, so a
 * cwd-relative lookup made every "drop a wav into your workspace" promise
 * silently false (T3 K3). Candidate directories are the caller's decision: pass
 * a `resolveSound` built from `createSoundResolver({ candidates })`.
 *
 * **Why playback escalation survives.** A subprocess handle's `done` promise
 * resolves for an ordinary non-zero exit and rejects only for spawn/provider
 * failures, so the old `done.catch(...)` chain never tried the fallback
 * interpreter (T3 N7). This engine inspects the resolved outcome as well.
 *
 * Frozen contract: `docs/adr/0001-persistence-seam.md` §5,
 * `docs/workstreams/03-plugin-audit.md` BC4/BC6/BC7/BC11 + K3/K7/N5/N7/N13.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { KINDS } from '../core/kinds.mjs'
import { DEFAULT_VOLUME, clampVolume } from '../core/volume.mjs'
import { scaleWavVolume } from '../core/wav.mjs'

/** Minimum gap between two plays of the same kind, in ms (BC4). */
export const DEFAULT_DEBOUNCE_MS = 2500

/** Terminate the player process if it has not exited within this window. */
export const PLAYER_GRACE_MS = 3000

/** Windows PowerShell 5.1, present on every supported Windows install. */
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * Encode a JS string as base64 of its UTF-16LE bytes — the encoding
 * `powershell -EncodedCommand` expects. Keeps paths containing quotes, spaces
 * and non-ASCII characters out of the command line entirely.
 * @param text Script text.
 * @returns Base64 payload.
 */
export function encodePowerShellCommand(text) {
  return Buffer.from(text, 'utf16le').toString('base64')
}

/**
 * Build the ordered argv candidates that play one file (BC11).
 *
 * Every candidate is tried in order; the first one that both spawns and exits
 * cleanly wins.
 * @param platform `process.platform` value.
 * @param file Path of the file to play.
 * @returns One `{ argv, cwd }` per attempt.
 */
export function playbackAttempts(platform, file) {
  if (platform === 'win32') {
    // Single-quoted PowerShell string: double the quote, nothing else is special.
    const escaped = file.replace(/'/g, "''")
    const encoded = encodePowerShellCommand(`$p = New-Object Media.SoundPlayer '${escaped}'; $p.PlaySync()`)
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
    return [
      { argv: [WINDOWS_POWERSHELL, ...args], cwd: 'C:\\Windows' },
      { argv: ['pwsh.exe', ...args], cwd: 'C:\\Windows' },
    ]
  }
  if (platform === 'darwin') return [{ argv: ['/usr/bin/afplay', file], cwd: '/' }]
  return [
    { argv: ['paplay', file], cwd: '/' },
    { argv: ['aplay', file], cwd: '/' },
  ]
}

/**
 * Build a sound resolver over ordered directories (BC6).
 *
 * The resolver returns the first existing candidate, and `null` when nothing
 * exists — never a synthesized path the player would then fail on (T3 N13).
 * Precedence is the caller's: the documented order is configured `soundDir`,
 * then the session workspace, then the bundled `sounds/`, then OS fallbacks.
 *
 * @param options Resolver inputs.
 * @param options.candidates Absolute directories, most preferred first.
 * @param options.exists Existence predicate; defaults to `node:fs`.
 * @param options.join Path joiner; defaults to `node:path`.
 * @returns `(kind) => string | null`.
 */
export function createSoundResolver({ candidates, exists = existsSync, join: joinPath = join } = {}) {
  const dirs = Array.isArray(candidates)
    ? candidates.filter((dir) => typeof dir === 'string' && dir.length > 0)
    : []
  return (kind) => {
    for (const dir of dirs) {
      const path = joinPath(dir, `${kind}.wav`)
      try {
        if (exists(path)) return path
      } catch {
        /* an unreadable candidate directory is just a miss */
      }
    }
    return null
  }
}

/**
 * Build the playback engine.
 *
 * @param options Engine inputs.
 * @param options.platform Target platform; injected so tests never rewrite
 *   `process.platform` (T3 N19).
 * @param options.resolveSound `(kind) => string | null`; see {@link createSoundResolver}.
 * @param options.spawn Plays one argv; see the contract below.
 * @param options.debounceMs Per-kind minimum gap in ms; `0`/absent = no limit.
 * @param options.currentVolume `() => number`; read at play time, so a settings
 *   change applies to the next sound without rebuilding the engine.
 * @param options.now Clock in ms; injectable so tests need no real time.
 * @param options.scaleFrameScaling Override the WAV scaler (tests, or a host
 *   that scales elsewhere).
 * @returns The engine.
 *
 * `spawn` contract — the adapter built on `ctx.get('subprocess').spawn`:
 * ```js
 * spawn: (argv, { cwd, graceMs }) => subprocess.spawn({
 *   argv, cwd, graceMs,
 *   stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
 * })
 * ```
 * The engine awaits the returned handle's `done` promise when there is one and
 * treats a non-zero `exitCode` as a failed attempt, so the next candidate is
 * tried. A `spawn` that throws or rejects is also a failed attempt. A `spawn`
 * that cannot report an outcome may return `undefined`; that attempt then
 * counts as accepted, matching fire-and-forget playback.
 */
export function createEngine({
  platform = process.platform,
  resolveSound,
  spawn,
  debounceMs,
  currentVolume,
  now = () => Date.now(),
  scaleFrameScaling = scaleWavVolume,
} = {}) {
  if (typeof resolveSound !== 'function') {
    throw new TypeError('createEngine requires a resolveSound(kind) function')
  }
  if (typeof spawn !== 'function') {
    throw new TypeError('createEngine requires a spawn(argv, { cwd, graceMs }) function')
  }
  const window = typeof debounceMs === 'number' && Number.isFinite(debounceMs) && debounceMs > 0
    ? debounceMs
    : 0
  const lastPlayed = new Map()

  /** Consume one kind's window; `force` (settings-page preview) skips it. */
  const gate = (kind, force) => {
    if (force || window === 0) return true
    const stamp = now()
    const previous = lastPlayed.get(kind)
    if (previous !== undefined && stamp - previous < window) return false
    lastPlayed.set(kind, stamp)
    return true
  }

  /** Read the live volume, tolerating a corrupt or missing value (BC7). */
  const volumeNow = () => {
    try {
      return clampVolume(typeof currentVolume === 'function' ? currentVolume() : DEFAULT_VOLUME)
    } catch {
      return DEFAULT_VOLUME
    }
  }

  /**
   * Try each candidate argv in order until one is accepted.
   * @param attempts Candidates from {@link playbackAttempts}.
   * @returns Whether some attempt was accepted.
   */
  const spawnBeep = async (attempts) => {
    for (const attempt of attempts) {
      let handle
      try {
        handle = spawn(attempt.argv, { cwd: attempt.cwd, graceMs: PLAYER_GRACE_MS })
      } catch {
        continue
      }
      const done = handle === null || typeof handle !== 'object' ? undefined : handle.done
      if (done === null || typeof done !== 'object' || typeof done.then !== 'function') return true
      try {
        const outcome = await done
        // A non-zero exit is a failed attempt too — the distinction the old
        // `done.catch(...)` chain could not make (T3 N7).
        const exitCode = outcome === null || typeof outcome !== 'object' ? undefined : outcome.exitCode
        if (typeof exitCode === 'number' && exitCode !== 0) continue
        return true
      } catch {
        continue
      }
    }
    return false
  }

  const resolveOne = (kind) => {
    const resolved = resolveSound(kind)
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null
  }

  return {
    /**
     * Resolve the playable source for one kind (BC6).
     * @param kind One of `KINDS`.
     * @returns Path, or `null` when no candidate exists.
     */
    resolveSound(kind) {
      return resolveOne(kind)
    },

    /**
     * Play one kind, subject to the per-kind window.
     * @param kind One of `KINDS`.
     * @param options Play options.
     * @param options.force Skip the window (settings-page preview).
     * @returns Structured outcome; never throws.
     */
    play(kind, { force = false } = {}) {
      if (!KINDS.includes(kind)) return { played: false, reason: 'unknown-kind', kind }
      if (!gate(kind, force)) return { played: false, reason: 'debounced', kind }

      const volume = volumeNow()
      if (volume <= 0) return { played: false, reason: 'muted', kind, volume }

      const resolved = resolveOne(kind)
      if (resolved === null) return { played: false, reason: 'no-sound', kind, volume }

      let playable = resolved
      try {
        playable = scaleFrameScaling(resolved, volume)
      } catch {
        playable = resolved
      }

      // `settled` resolves to whether some candidate was accepted; awaiting it
      // is the caller's choice, so a caller that cannot observe outcomes (or
      // deliberately fires and forgets) still works.
      return {
        played: true,
        kind,
        volume,
        source: resolved,
        file: playable,
        settled: spawnBeep(playbackAttempts(platform, playable)),
      }
    },
  }
}
